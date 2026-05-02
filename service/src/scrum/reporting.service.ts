import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import type { ClickUpTaskFull } from "../clickup/clickup-direct.service";
import { runWithPriority } from "../clickup/priority-context";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { isoWeekOf, ymd } from "../util/iso-week";
import { bar, ratio, sparkline } from "../util/progress-bar";
import { AuditService } from "./audit.service";
import {
	type ReviewerSla,
	ReviewEventsService,
	renderReviewSlaMd,
} from "./review-events.service";
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
		private readonly reviewEvents: ReviewEventsService,
	) {}

	// ── standup ────────────────────────────────────────────────────────

	async generateStandup(
		projectId: string,
		dryRun: boolean,
	): Promise<StandupReport> {
		// Plan §C.8 — autonomous SCRUM never preempts user/lifecycle traffic.
		return runWithPriority("scrum", () =>
			this.generateStandupInternal(projectId, dryRun),
		);
	}

	private async generateStandupInternal(
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

		// Plan §F.2 — pull cached GitHub identities for the active authors,
		// keyed lowercase email so the standup template can render avatar
		// + login link instead of raw email. Identities not yet resolved
		// fall back to plain `## email` headers.
		const identities = await this.loadIdentitiesForAuthors(
			Array.from(byAuthor.keys()),
		);

		const since24h = new Date(now.getTime() - 24 * 3600 * 1000);
		const deploySummary = await this.loadDeploySummary(
			project.id,
			since24h,
			"24h",
		);

		const markdown = renderStandupMd({
			projectName: project.display_name,
			today,
			isoWeek,
			byAuthor,
			openBlockers,
			sprintTasks,
			identities,
			deploySummary: deploySummary ?? undefined,
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
		// Plan §C.8 — autonomous SCRUM never preempts user/lifecycle traffic.
		return runWithPriority("scrum", () =>
			this.generateRetroInternal(projectId, dryRun),
		);
	}

	private async generateRetroInternal(
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

		// Plan §I.2 — Review SLA section pulled from github_review_events.
		const reviewerSla = await this.reviewEvents.slaForProject(project.id, 30);

		// Plan §N.7 — deployment frequency + MTTR over the closing sprint.
		const deploySummary = await this.loadDeploySummary(
			project.id,
			new Date(start),
			"this sprint",
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
			reviewerSla,
			deploySummary: deploySummary ?? undefined,
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

	/**
	 * Plan §F.2 — return cached identities keyed by lowercase email for the
	 * given author emails. Reads from `github_identities` only (no on-demand
	 * GitHub API call here — the events-service path keeps the cache warm).
	 */
	private async loadIdentitiesForAuthors(emails: string[]): Promise<
		Map<
			string,
			{
				github_login: string | null;
				github_url: string | null;
				avatar_url: string | null;
			}
		>
	> {
		const out = new Map<
			string,
			{
				github_login: string | null;
				github_url: string | null;
				avatar_url: string | null;
			}
		>();
		const lower = emails
			.map((e) => (e ?? "").toLowerCase())
			.filter((e) => e.length > 0);
		if (lower.length === 0) return out;
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					email: string;
					github_login: string | null;
					github_url: string | null;
					avatar_url: string | null;
				}>
			>(
				`SELECT email, github_login, github_url, avatar_url
				 FROM clickup_tracker.github_identities
				 WHERE email = ANY($1::text[])`,
				lower,
			);
			for (const r of rows) {
				out.set(r.email, {
					github_login: r.github_login,
					github_url: r.github_url,
					avatar_url: r.avatar_url,
				});
			}
		} catch (err) {
			this.log.debug(
				`loadIdentitiesForAuthors failed: ${(err as Error).message}`,
			);
		}
		return out;
	}

	/**
	 * Plan §N.7 — fetch raw deploy rows in [since, now) and summarise per
	 * env. Returns `null` (not an empty summary) when the table is missing
	 * so the renderer can omit the section entirely on cold-start daemons.
	 */
	private async loadDeploySummary(
		projectId: string,
		since: Date,
		windowLabel: string,
	): Promise<DeploySummary | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					environment: string;
					status: string;
					started_at: Date | null;
					finished_at: Date | null;
				}>
			>(
				`SELECT environment, status, started_at, finished_at
				 FROM clickup_tracker.railway_deployments
				 WHERE project_id = $1::uuid
				   AND COALESCE(started_at, updated_at) >= $2::timestamptz`,
				projectId,
				since.toISOString(),
			);
			return summariseDeployments(rows, windowLabel);
		} catch (err) {
			this.log.debug(`loadDeploySummary failed: ${(err as Error).message}`);
			return null;
		}
	}

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
	identities?: Map<
		string,
		{
			github_login: string | null;
			github_url: string | null;
			avatar_url: string | null;
		}
	>;
	deploySummary?: DeploySummary;
}): string {
	const lines: string[] = [];
	const open = args.sprintTasks.filter(
		(t) => !isDoneStatus(t.status?.type ?? t.status?.status),
	);
	const done = args.sprintTasks.length - open.length;

	lines.push(`# Standup — ${args.today}`);
	lines.push("");
	lines.push(`**Project:** ${args.projectName} · **Sprint:** ${args.isoWeek}`);
	lines.push("");

	// Sprint health blockquote — visual at-a-glance summary.
	lines.push("> **Sprint Health**");
	lines.push(`> Progress: \`${bar(done, args.sprintTasks.length, 16)}\``);
	lines.push(
		`> Tickets: ${done} done · ${open.length} in flight · ${args.openBlockers.length} blocker(s)`,
	);
	lines.push("");

	// Per-author summary table (G.1).
	lines.push("## Per-author summary");
	lines.push("");
	if (args.byAuthor.size === 0) {
		lines.push("_No commits in the last 24 hours._");
	} else {
		lines.push("| Contributor | Yesterday | Top commit |");
		lines.push("|---|---|---|");
		for (const [author, commits] of args.byAuthor) {
			const id = args.identities?.get(author.toLowerCase());
			const who = formatAuthorCell(author, id);
			const top = commits[0]
				? `\`${commits[0].sha.slice(0, 8)}\` ${escapeCell(commits[0].subject)}`
				: "—";
			lines.push(`| ${who} | ${commits.length} commit(s) | ${top} |`);
		}
		lines.push("");

		// Detailed activity collapsed by default.
		lines.push("<details><summary>Detailed activity</summary>");
		lines.push("");
		for (const [author, commits] of args.byAuthor) {
			const id = args.identities?.get(author.toLowerCase());
			lines.push(formatAuthorHeader(author, id));
			lines.push(`**Yesterday:** ${commits.length} commit(s)`);
			for (const c of commits.slice(0, 8)) {
				lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject}`);
			}
			if (commits.length > 8) {
				lines.push(`- _… +${commits.length - 8} more_`);
			}
			lines.push("");
		}
		lines.push("</details>");
	}
	lines.push("");
	lines.push("---");
	lines.push("");

	if (args.deploySummary) {
		lines.push("## Deployments (last 24h)");
		lines.push(renderDeploySummaryMd(args.deploySummary));
		lines.push("");
	}

	lines.push("## Today");
	if (args.sprintTasks.length === 0) {
		lines.push("_No tasks in the current sprint List._");
	} else {
		lines.push(
			`Sprint progress: **${ratio(done, args.sprintTasks.length)}** delivered.`,
		);
		lines.push("");
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

function escapeCell(s: string): string {
	return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatAuthorCell(
	author: string,
	identity?: {
		github_login: string | null;
		github_url: string | null;
		avatar_url: string | null;
	},
): string {
	if (identity?.github_login && identity?.github_url) {
		const avatar = identity.avatar_url ? `![](${identity.avatar_url}) ` : "";
		return `${avatar}[${identity.github_login}](${identity.github_url})`;
	}
	return author;
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
	reviewerSla?: ReviewerSla[];
	deploySummary?: DeploySummary;
}): string {
	const lines: string[] = [];
	const delta = args.deliveredTasks - args.committedTasks;
	const sign = delta > 0 ? "+" : "";
	const net = args.closedBugs - args.newBugs;

	lines.push(`# Retro — ${args.isoWeek}`);
	lines.push("");
	lines.push(`**Project:** ${args.projectName}`);
	lines.push("");

	// Velocity sparkline (G.2) — last few sprints' commit count.
	lines.push("## Velocity");
	lines.push("");
	lines.push(
		`Delivered this sprint: \`${bar(args.deliveredTasks, args.committedTasks, 16)}\``,
	);
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|---|---|");
	lines.push(`| Committed | **${args.committedTasks}** tasks |`);
	lines.push(`| Delivered | **${args.deliveredTasks}** tasks |`);
	lines.push(`| Delta | ${sign}${delta} |`);
	lines.push(`| Carryover | ${args.carryoverCount} task(s) into next sprint |`);
	lines.push("");
	if (args.velocityWindow.length > 0) {
		const series = args.velocityWindow.map((v) => v.committed_tasks);
		lines.push(
			`**Trend (last ${series.length} sprints):** \`${sparkline(series)}\``,
		);
		lines.push("");
		lines.push("| Sprint | Committed |");
		lines.push("|---|---|");
		for (const v of args.velocityWindow) {
			lines.push(`| ${v.iso_week} | ${v.committed_tasks} |`);
		}
		lines.push("");
	}

	// Bug throughput.
	lines.push("## Bug throughput (this week)");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|---|---|");
	lines.push(`| Bug-related commits | ${args.newBugs} |`);
	lines.push(`| \`fix\` commits | ${args.closedBugs} |`);
	lines.push(
		`| Net | ${net >= 0 ? "✓" : "✗"} ${net >= 0 ? "+" : ""}${net} (closed − new) |`,
	);
	lines.push("");

	// Plan §I.2 — PR review SLA over the trailing 30 days. Always render
	// the heading so the reader knows the section *exists* (and isn't just
	// missing from a stale template); body becomes a friendly placeholder
	// when no events have been ingested yet.
	if (args.reviewerSla !== undefined) {
		lines.push("## Review SLA (last 30 days)");
		lines.push("");
		lines.push(renderReviewSlaMd(args.reviewerSla));
		lines.push("");
	}

	if (args.deploySummary) {
		lines.push("## Deployment summary (this sprint)");
		lines.push("");
		lines.push(renderDeploySummaryMd(args.deploySummary));
		lines.push("");
	}

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

/**
 * Plan §F.2 — author section header. Identity-aware: when we have a cached
 * GitHub identity, render `## ![avatar] [Display](url)` followed by the
 * email on a sub-line. Falls back to plain `## email` when identity is
 * unknown so the page still renders.
 */
export function formatAuthorHeader(
	author: string,
	identity?: {
		github_login: string | null;
		github_url: string | null;
		avatar_url: string | null;
	},
): string {
	if (identity?.github_login && identity?.github_url) {
		const avatar = identity.avatar_url ? `![](${identity.avatar_url}) ` : "";
		return (
			`## ${avatar}[${identity.github_login}](${identity.github_url})\n` +
			`*${author}*`
		);
	}
	return `## ${author}`;
}

/**
 * Plan §N.7 — deployment rollup surfaced in standup + retro Doc pages.
 *
 * Aggregates from `clickup_tracker.railway_deployments` for a project
 * over a window: total, success/failure/cancelled counts per env,
 * mean time-to-recovery (MTTR) for failed-then-recovered streaks.
 */
export interface DeploySummary {
	window: string; // e.g. "24h" or "this sprint"
	total: number;
	byEnv: Array<{
		environment: string;
		total: number;
		success: number;
		failure: number;
		cancelled: number;
		mttrSeconds: number | null;
	}>;
}

export function renderDeploySummaryMd(s: DeploySummary): string {
	const lines: string[] = [];
	if (s.total === 0) {
		lines.push(`_No deployments in the ${s.window}._`);
		return lines.join("\n");
	}
	lines.push(`Total: **${s.total}** deployment(s) in the ${s.window}.`);
	lines.push("");
	lines.push("| Environment | Total | ✅ | ❌ | ⏸ | MTTR |");
	lines.push("|---|---|---|---|---|---|");
	for (const e of s.byEnv) {
		const mttr =
			e.mttrSeconds == null ? "—" : `${Math.round(e.mttrSeconds / 60)}m`;
		lines.push(
			`| \`${e.environment}\` | ${e.total} | ${e.success} | ${e.failure} | ${e.cancelled} | ${mttr} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Aggregate raw deployment rows (Railway-style status field) into the
 * shape the renderer needs. MTTR is the average gap from a FAILED row
 * to the next non-FAILED row (in seconds). Returns 0-row summary when
 * the input is empty.
 */
export function summariseDeployments(
	rows: Array<{
		environment: string;
		status: string;
		started_at: Date | string | null;
		finished_at: Date | string | null;
	}>,
	window: string,
): DeploySummary {
	const byEnv = new Map<
		string,
		{
			total: number;
			success: number;
			failure: number;
			cancelled: number;
			recoveryGaps: number[];
			pendingFailureAt: number | null;
		}
	>();
	const sorted = [...rows].sort((a, b) => {
		const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
		const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
		return ta - tb;
	});
	for (const r of sorted) {
		const env = r.environment || "unknown";
		const stats = byEnv.get(env) ?? {
			total: 0,
			success: 0,
			failure: 0,
			cancelled: 0,
			recoveryGaps: [] as number[],
			pendingFailureAt: null as number | null,
		};
		stats.total += 1;
		const s = r.status?.toUpperCase?.() ?? "";
		const t = r.started_at ? new Date(r.started_at).getTime() : 0;
		if (s === "SUCCESS") {
			stats.success += 1;
			if (stats.pendingFailureAt && t > stats.pendingFailureAt) {
				stats.recoveryGaps.push((t - stats.pendingFailureAt) / 1000);
				stats.pendingFailureAt = null;
			}
		} else if (s === "FAILED" || s === "CRASHED") {
			stats.failure += 1;
			if (stats.pendingFailureAt == null) stats.pendingFailureAt = t;
		} else if (s === "CANCELLED" || s === "REMOVED") {
			stats.cancelled += 1;
		}
		byEnv.set(env, stats);
	}
	return {
		window,
		total: rows.length,
		byEnv: [...byEnv.entries()]
			.sort((a, b) => b[1].total - a[1].total)
			.map(([environment, e]) => ({
				environment,
				total: e.total,
				success: e.success,
				failure: e.failure,
				cancelled: e.cancelled,
				mttrSeconds:
					e.recoveryGaps.length > 0
						? e.recoveryGaps.reduce((sum, g) => sum + g, 0) /
							e.recoveryGaps.length
						: null,
			})),
	};
}
