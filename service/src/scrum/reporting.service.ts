import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import type { ClickUpTaskFull } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { isoWeekOf, ymd } from "../util/iso-week";
import { AuditService } from "./audit.service";
import { isDoneStatus } from "./sprint-planner.service";

/**
 * Plan §C.4 — autonomous standup + retro reporting.
 *
 * Standup (every weekday morning):
 *   - Last 24h git_events grouped by author email
 *   - Current sprint List tasks (today's planned work)
 *   - Open blocker bugs (priority=Urgent or tag=blocked)
 *   - Render → markdown page in the project Doc under "Standups"
 *   - Idempotent on UTC date; skipped on weekends + configured holidays
 *
 * Retro (Sunday evening, end of sprint):
 *   - Velocity actual vs committed (from velocity_window)
 *   - Bugs opened vs closed during the sprint window
 *   - Carryover analysis
 *   - Render → markdown page in the project Doc under "Retros"
 *   - Idempotent on iso_week (the just-finished sprint)
 *
 * Both surface as `{skipped:'no_doc'}` if the project has no
 * clickup_doc_id (Plan §A.2 guarantees this is non-null after the
 * first successful backfill, but old projects from pre-A.2 days may
 * still be missing it).
 */

export interface StandupReport {
	dryRun: boolean;
	skipped?: string;
	dateUtc?: string;
	pageId?: string;
	parentPageId?: string;
	authors: number;
	commits: number;
	openBlockers: number;
	currentSprintTasks: number;
	markdown: string;
}

export interface RetroReport {
	dryRun: boolean;
	skipped?: string;
	isoWeek?: string;
	pageId?: string;
	parentPageId?: string;
	committedTasks: number;
	deliveredTasks: number;
	newBugs: number;
	closedBugs: number;
	carryoverCount: number;
	markdown: string;
}

interface ProjectMin {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_doc_id: string | null;
	display_name: string;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	scrum_config: Record<string, unknown> | null;
	last_standup_at: Date | null;
	last_retro_at: Date | null;
	velocity_window: Array<{
		iso_week: string;
		committed_tasks: number;
		at: string;
	}> | null;
}

interface ReportConfig {
	tz: string;
	skip_weekends: boolean;
	holidays: string[];
	standup_max_history_days: number;
}

const REPORT_DEFAULTS: ReportConfig = {
	tz: "UTC",
	skip_weekends: true,
	holidays: [],
	standup_max_history_days: 60,
};

const STANDUPS_PAGE_NAME = "Standups";
const RETROS_PAGE_NAME = "Retros";

@Injectable()
export class ReportingService {
	private readonly log = new Logger(ReportingService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly audit: AuditService,
	) {}

	// ── standup ────────────────────────────────────────────────────────

	async generateStandup(
		projectId: string,
		dryRun: boolean,
	): Promise<StandupReport> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");
		const cfg = mergeReportConfig(project.scrum_config ?? {});
		const now = new Date();
		const today = ymd(now);

		// Idempotency.
		if (project.last_standup_at && ymd(project.last_standup_at) === today) {
			return emptyStandup(dryRun, "already_done_today", today);
		}
		if (cfg.skip_weekends && isWeekendUtc(now)) {
			return emptyStandup(dryRun, "weekend", today);
		}
		if (cfg.holidays.includes(today)) {
			return emptyStandup(dryRun, "holiday", today);
		}
		if (!project.clickup_doc_id) {
			return emptyStandup(dryRun, "no_doc", today);
		}

		const creds = await this.credentials.forOrg(project.organisation_id);

		// 1. Last 24h git_events grouped by author.
		const events = await this.fetchEvents24h(project.id);
		const byAuthor = new Map<string, Array<{ sha: string; subject: string }>>();
		for (const e of events) {
			const key = (e.author ?? e.committer_email ?? "(unknown)").toLowerCase();
			const arr = byAuthor.get(key) ?? [];
			arr.push({ sha: e.commit_sha, subject: extractSubject(e.message) });
			byAuthor.set(key, arr);
		}

		// 2. Open blockers — open bugs that are priority=Urgent OR carry
		//    a `blocked` tag. Plain open bugs aren't "blockers", they're
		//    just open bugs; the standup section is for things gating work.
		let openBlockers: ClickUpTaskFull[] = [];
		const bugsListId = project.list_ids?.bugs;
		if (bugsListId) {
			const bugs = await this.fetchTasks(bugsListId, creds.token);
			openBlockers = bugs.filter((t) => {
				if (isDoneStatus(t.status?.type ?? t.status?.status)) return false;
				const anyT = t as unknown as {
					priority?: { priority?: string; id?: string | number };
					tags?: Array<{ name?: string }>;
				};
				const isUrgent =
					anyT.priority?.priority === "urgent" ||
					String(anyT.priority?.id ?? "") === "1";
				const hasBlockedTag = (anyT.tags ?? []).some(
					(tag) => (tag?.name ?? "").toLowerCase() === "blocked",
				);
				return isUrgent || hasBlockedTag;
			});
		}

		// 3. Current sprint List tasks.
		const isoWeek = isoWeekOf(now).key;
		let sprintTasks: ClickUpTaskFull[] = [];
		const currentSprintListId = project.sprint_lists?.[isoWeek];
		if (currentSprintListId) {
			sprintTasks = await this.fetchTasks(currentSprintListId, creds.token);
		}

		const markdown = renderStandupMd({
			projectName: project.display_name,
			today,
			isoWeek,
			byAuthor,
			openBlockers,
			sprintTasks,
		});

		const report: StandupReport = {
			dryRun,
			dateUtc: today,
			authors: byAuthor.size,
			commits: events.length,
			openBlockers: openBlockers.length,
			currentSprintTasks: sprintTasks.length,
			markdown,
		};

		if (dryRun) {
			await this.audit.record({
				projectId: project.id,
				kind: "standup",
				before: null,
				after: { dateUtc: today, summary: summariseStandup(report) },
				reason: `dry-run standup ${today}`,
				dryRun: true,
			});
			return report;
		}

		// 4. Find/create Standups parent page, then post the day's child page.
		try {
			const parent = await this.ensureSubpage(
				project,
				creds.token,
				STANDUPS_PAGE_NAME,
			);
			report.parentPageId = parent;
			const created = await this.clickup.createDocPage(
				project.clickup_team_id,
				project.clickup_doc_id!,
				{
					name: `Standup — ${today}`,
					content: markdown,
					parent_page_id: parent,
				},
				creds.token,
			);
			report.pageId = created.id;
		} catch (err) {
			this.log.warn(`standup page post failed: ${(err as Error).message}`);
			report.skipped = "page_post_failed";
			return report;
		}

		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET last_standup_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid`,
			project.id,
		);
		await this.audit.record({
			projectId: project.id,
			kind: "standup",
			target: report.pageId,
			after: { dateUtc: today, summary: summariseStandup(report) },
			reason: `standup posted ${today}`,
		});
		return report;
	}

	// ── retro ──────────────────────────────────────────────────────────

	async generateRetro(
		projectId: string,
		dryRun: boolean,
	): Promise<RetroReport> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");
		const now = new Date();

		// Retro is for the just-finished sprint — i.e. the iso_week that
		// ended yesterday. On Sun 18:00 UTC, that's *this* week (since the
		// week ends Sunday). Use today's iso_week.
		const sprintIsoWeek = isoWeekOf(now).key;

		// Idempotency — only one retro per sprint.
		if (
			project.last_retro_at &&
			isoWeekOf(project.last_retro_at).key === sprintIsoWeek
		) {
			return emptyRetro(dryRun, "already_done_this_sprint", sprintIsoWeek);
		}
		if (!project.clickup_doc_id) {
			return emptyRetro(dryRun, "no_doc", sprintIsoWeek);
		}

		const creds = await this.credentials.forOrg(project.organisation_id);

		// 1. Committed (from velocity_window).
		const committedEntry = (project.velocity_window ?? []).find(
			(v) => v.iso_week === sprintIsoWeek,
		);
		const committedTasks = committedEntry?.committed_tasks ?? 0;

		// 2. Delivered (Done count in the sprint List).
		const sprintListId = project.sprint_lists?.[sprintIsoWeek];
		let deliveredTasks = 0;
		let carryoverCount = 0;
		if (sprintListId) {
			const tasks = await this.fetchTasks(sprintListId, creds.token);
			for (const t of tasks) {
				if (isDoneStatus(t.status?.type ?? t.status?.status)) {
					deliveredTasks += 1;
				} else {
					carryoverCount += 1;
				}
			}
		}

		// 3. Bug intro/resolve diff during the sprint window.
		const wk = isoWeekOf(now);
		const start = `${wk.startDate}T00:00:00Z`;
		const end = `${wk.endDate}T23:59:59Z`;
		const newBugs = await this.countCommitsByPattern(
			project.id,
			"^(fix|feat|chore|refactor)\\(.*?\\):",
			start,
			end,
			"BUG",
		);
		const closedBugs = await this.countCommitsByPattern(
			project.id,
			"^fix\\(",
			start,
			end,
			null,
		);

		const markdown = renderRetroMd({
			projectName: project.display_name,
			isoWeek: sprintIsoWeek,
			committedTasks,
			deliveredTasks,
			carryoverCount,
			newBugs,
			closedBugs,
			velocityWindow: (project.velocity_window ?? []).slice(-4),
		});

		const report: RetroReport = {
			dryRun,
			isoWeek: sprintIsoWeek,
			committedTasks,
			deliveredTasks,
			newBugs,
			closedBugs,
			carryoverCount,
			markdown,
		};

		if (dryRun) {
			await this.audit.record({
				projectId: project.id,
				kind: "retro",
				before: null,
				after: { isoWeek: sprintIsoWeek, summary: summariseRetro(report) },
				reason: `dry-run retro ${sprintIsoWeek}`,
				dryRun: true,
			});
			return report;
		}

		try {
			const parent = await this.ensureSubpage(
				project,
				creds.token,
				RETROS_PAGE_NAME,
			);
			report.parentPageId = parent;
			const created = await this.clickup.createDocPage(
				project.clickup_team_id,
				project.clickup_doc_id!,
				{
					name: `Retro — ${sprintIsoWeek}`,
					content: markdown,
					parent_page_id: parent,
				},
				creds.token,
			);
			report.pageId = created.id;
		} catch (err) {
			this.log.warn(`retro page post failed: ${(err as Error).message}`);
			report.skipped = "page_post_failed";
			return report;
		}

		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET last_retro_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid`,
			project.id,
		);
		await this.audit.record({
			projectId: project.id,
			kind: "retro",
			target: report.pageId,
			after: { isoWeek: sprintIsoWeek, summary: summariseRetro(report) },
			reason: `retro posted ${sprintIsoWeek}`,
		});
		return report;
	}

	// ── helpers ────────────────────────────────────────────────────────

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, clickup_team_id, clickup_doc_id,
              display_name, list_ids, sprint_lists, scrum_config,
              last_standup_at, last_retro_at, velocity_window
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async fetchTasks(
		listId: string,
		token: string,
	): Promise<ClickUpTaskFull[]> {
		try {
			return await this.clickup.listTasksInList(listId, token);
		} catch (err) {
			this.log.warn(
				`reporting fetchTasks(${listId}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	private async fetchEvents24h(projectId: string): Promise<
		Array<{
			commit_sha: string;
			author: string | null;
			committer_email: string | null;
			message: string;
		}>
	> {
		try {
			return await this.prisma.$queryRawUnsafe<
				Array<{
					commit_sha: string;
					author: string | null;
					committer_email: string | null;
					message: string;
				}>
			>(
				`SELECT commit_sha, author, committer_email, message
         FROM clickup_tracker.git_events
         WHERE project_id = $1::uuid
           AND created_at > NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC
         LIMIT 100`,
				projectId,
			);
		} catch (err) {
			this.log.warn(`fetchEvents24h failed: ${(err as Error).message}`);
			return [];
		}
	}

	private async countCommitsByPattern(
		projectId: string,
		pattern: string,
		startIso: string,
		endIso: string,
		messageContains: string | null,
	): Promise<number> {
		try {
			const params: unknown[] = [projectId, pattern, startIso, endIso];
			let extra = "";
			if (messageContains) {
				params.push(`%${messageContains}%`);
				extra = ` AND message LIKE $${params.length}`;
			}
			const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
				`SELECT COUNT(*)::bigint AS n
         FROM clickup_tracker.git_events
         WHERE project_id = $1::uuid
           AND message ~ $2
           AND created_at >= $3::timestamptz
           AND created_at <= $4::timestamptz${extra}`,
				...params,
			);
			return Number(rows[0]?.n ?? 0);
		} catch {
			return 0;
		}
	}

	/**
	 * Find a top-level Doc page by name; create it if it doesn't exist.
	 * Returns the page id.
	 */
	private async ensureSubpage(
		project: ProjectMin,
		token: string,
		pageName: string,
	): Promise<string> {
		const docId = project.clickup_doc_id!;
		const teamId = project.clickup_team_id;
		const pages = await this.clickup.listDocPages(teamId, docId, token);
		const existing = pages.find(
			(p) => (p.name ?? "").toLowerCase() === pageName.toLowerCase(),
		);
		if (existing) return existing.id;
		const created = await this.clickup.createDocPage(
			teamId,
			docId,
			{
				name: pageName,
				content: `_Auto-managed by clickup-tracker. Daily ${pageName.toLowerCase()} pages are appended below._`,
			},
			token,
		);
		return created.id;
	}
}

// ── pure helpers ──────────────────────────────────────────────────────

export function isWeekendUtc(d: Date): boolean {
	const day = d.getUTCDay();
	return day === 0 || day === 6;
}

export function extractSubject(message: string): string {
	return (message ?? "").split("\n", 1)[0] ?? "";
}

export function renderStandupMd(args: {
	projectName: string;
	today: string;
	isoWeek: string;
	byAuthor: Map<string, Array<{ sha: string; subject: string }>>;
	openBlockers: ClickUpTaskFull[];
	sprintTasks: ClickUpTaskFull[];
}): string {
	const lines: string[] = [];
	lines.push(`# Standup — ${args.today}`);
	lines.push("");
	lines.push(`**Project:** ${args.projectName} · **Sprint:** ${args.isoWeek}`);
	lines.push("");
	if (args.byAuthor.size === 0) {
		lines.push("_No commits in the last 24 hours._");
	} else {
		for (const [author, commits] of args.byAuthor) {
			lines.push(`## ${author}`);
			lines.push(`**Yesterday:** ${commits.length} commit(s)`);
			for (const c of commits.slice(0, 8)) {
				lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject}`);
			}
			if (commits.length > 8) {
				lines.push(`- _… +${commits.length - 8} more_`);
			}
			lines.push("");
		}
	}
	lines.push("---");
	lines.push("");
	lines.push("## Today");
	if (args.sprintTasks.length === 0) {
		lines.push("_No tasks in the current sprint List._");
	} else {
		const open = args.sprintTasks.filter(
			(t) => !isDoneStatus(t.status?.type ?? t.status?.status),
		);
		const done = args.sprintTasks.length - open.length;
		lines.push(
			`Sprint progress: **${done} done** / ${args.sprintTasks.length} total.`,
		);
		for (const t of open.slice(0, 10)) {
			lines.push(`- ${t.name}`);
		}
		if (open.length > 10) {
			lines.push(`- _… +${open.length - 10} more in flight_`);
		}
	}
	lines.push("");
	lines.push("## Blockers");
	if (args.openBlockers.length === 0) {
		lines.push("_No open bugs._");
	} else {
		for (const b of args.openBlockers.slice(0, 10)) {
			lines.push(`- ${b.name}`);
		}
		if (args.openBlockers.length > 10) {
			lines.push(`- _… +${args.openBlockers.length - 10} more_`);
		}
	}
	return lines.join("\n");
}

export function renderRetroMd(args: {
	projectName: string;
	isoWeek: string;
	committedTasks: number;
	deliveredTasks: number;
	carryoverCount: number;
	newBugs: number;
	closedBugs: number;
	velocityWindow: Array<{ iso_week: string; committed_tasks: number }>;
}): string {
	const lines: string[] = [];
	lines.push(`# Retro — ${args.isoWeek}`);
	lines.push("");
	lines.push(`**Project:** ${args.projectName}`);
	lines.push("");
	lines.push("## Velocity");
	lines.push(`- Committed: **${args.committedTasks} tasks**`);
	lines.push(`- Delivered: **${args.deliveredTasks} tasks**`);
	const delta = args.deliveredTasks - args.committedTasks;
	const sign = delta > 0 ? "+" : "";
	lines.push(`- Delta: ${sign}${delta}`);
	lines.push(`- Carryover: ${args.carryoverCount} task(s) into next sprint`);
	if (args.velocityWindow.length > 0) {
		const trail = args.velocityWindow
			.map((v) => `${v.iso_week}=${v.committed_tasks}`)
			.join(", ");
		lines.push(`- Recent commits/week: ${trail}`);
	}
	lines.push("");
	lines.push("## Bug throughput (this week)");
	lines.push(`- Bug-related commits: ${args.newBugs}`);
	lines.push(`- \`fix\` commits: ${args.closedBugs}`);
	const net = args.closedBugs - args.newBugs;
	lines.push(
		`- Net: ${net >= 0 ? "✓" : "✗"} ${net >= 0 ? "+" : ""}${net} (closed - new)`,
	);
	lines.push("");
	if (args.carryoverCount >= 3) {
		lines.push("## ⚠ Carryover spike");
		lines.push(
			`${args.carryoverCount} tasks carried into next sprint — consider splitting larger items or trimming next sprint's commit.`,
		);
		lines.push("");
	}
	return lines.join("\n");
}

function mergeReportConfig(cfg: Record<string, unknown>): ReportConfig {
	return {
		tz: typeof cfg.tz === "string" ? cfg.tz : REPORT_DEFAULTS.tz,
		skip_weekends:
			typeof cfg.skip_weekends === "boolean"
				? cfg.skip_weekends
				: REPORT_DEFAULTS.skip_weekends,
		holidays: Array.isArray(cfg.holidays)
			? (cfg.holidays as string[])
			: REPORT_DEFAULTS.holidays,
		standup_max_history_days:
			typeof cfg.standup_max_history_days === "number"
				? cfg.standup_max_history_days
				: REPORT_DEFAULTS.standup_max_history_days,
	};
}

function emptyStandup(
	dryRun: boolean,
	skipped: string,
	dateUtc: string,
): StandupReport {
	return {
		dryRun,
		skipped,
		dateUtc,
		authors: 0,
		commits: 0,
		openBlockers: 0,
		currentSprintTasks: 0,
		markdown: "",
	};
}

function emptyRetro(
	dryRun: boolean,
	skipped: string,
	isoWeek: string,
): RetroReport {
	return {
		dryRun,
		skipped,
		isoWeek,
		committedTasks: 0,
		deliveredTasks: 0,
		newBugs: 0,
		closedBugs: 0,
		carryoverCount: 0,
		markdown: "",
	};
}

function summariseStandup(r: StandupReport): string {
	return `${r.authors} authors · ${r.commits} commits · ${r.openBlockers} open bugs · ${r.currentSprintTasks} sprint tasks`;
}

function summariseRetro(r: RetroReport): string {
	return `committed=${r.committedTasks} delivered=${r.deliveredTasks} carryover=${r.carryoverCount} bug_net=${r.closedBugs - r.newBugs}`;
}
