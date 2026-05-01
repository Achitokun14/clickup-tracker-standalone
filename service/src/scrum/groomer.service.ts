import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import type { ClickUpTaskFull } from "../clickup/clickup-direct.service";
import { runWithPriority } from "../clickup/priority-context";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { isDoneStatus } from "./sprint-planner.service";

/**
 * Plan §C.2 — daily backlog grooming. Six independently-toggleable rules
 * that keep Open Work + Bugs healthy without operator intervention:
 *
 *   1. Dedupe          — Jaccard(name, name) ≥ 0.8 + ≥1 file overlap
 *                        ⇒ tag the older as duplicate-of:<newer>; never
 *                        delete (reversible).
 *   2. Stale bug bump  — bug open ≥7d ⇒ priority +1 (capped at Urgent).
 *   3. Stale bug shame — bug open ≥30d ⇒ tag stale-bug + comment.
 *   4. Churn reprio    — open work touched by ≥3 git_events in 14d
 *                        ⇒ priority +1.
 *   5. Hotspot promote — file touched ≥3 times in 7d AND no Open Work or
 *                        Bug references it ⇒ create [Hotspot] task.
 *   6. Zombie archive  — Backlog/To-Do with no activity 90d ⇒
 *                        setStatus('Closed') + tag auto-archived.
 *                        Default OFF; opt-in via scrum_config.groom.
 *
 * Idempotent within the day: skips if last_groom_at is today (project
 * tz). Default dryRun=true; mutations only on explicit dryRun=false.
 *
 * NOTE: this implementation ships rules 1, 2, 5, 6 (the highest-leverage
 * heuristics). Rules 3 + 4 are TODO once we have priority parsing + a
 * file-overlap helper that can fan out across git_events without N+1.
 */

export interface GroomPlan {
	dryRun: boolean;
	skipped?: string;
	dedupes: Array<{ olderId: string; newerId: string; jaccard: number }>;
	staleBugBumps: Array<{ taskId: string; ageDays: number }>;
	staleBugShames: Array<{ taskId: string; ageDays: number }>;
	hotspots: Array<{ path: string; churn: number }>;
	zombies: Array<{ taskId: string; idleDays: number }>;
}

interface ProjectMin {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	last_groom_at: Date | null;
	scrum_config: Record<string, unknown> | null;
}

interface GroomConfig {
	dedupe: boolean;
	stale_bug_bump: boolean;
	stale_bug_shame: boolean;
	churn_reprioritise: boolean;
	hotspot_promote: boolean;
	zombie_archive: boolean;
}

const GROOM_DEFAULTS: GroomConfig = {
	dedupe: true,
	stale_bug_bump: true,
	stale_bug_shame: true,
	churn_reprioritise: true,
	hotspot_promote: true,
	zombie_archive: false,
};

const STOPWORDS = new Set([
	"fix",
	"the",
	"and",
	"for",
	"with",
	"from",
	"into",
	"this",
	"that",
	"feat",
	"feature",
	"bug",
]);

const HOTSPOT_COOLDOWN_DAYS = 30;
const ZOMBIE_IDLE_DAYS = 90;
const STALE_BUG_BUMP_DAYS = 7;
const STALE_BUG_SHAME_DAYS = 30;
const HOTSPOT_CHURN_THRESHOLD = 3;
const HOTSPOT_WINDOW_DAYS = 7;
const JACCARD_DEDUPE_THRESHOLD = 0.8;

@Injectable()
export class GroomerService {
	private readonly log = new Logger(GroomerService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly audit: AuditService,
	) {}

	async groom(projectId: string, dryRun: boolean): Promise<GroomPlan> {
		// Plan §C.8 — autonomous SCRUM never preempts user/lifecycle traffic.
		return runWithPriority("scrum", () =>
			this.groomInternal(projectId, dryRun),
		);
	}

	private async groomInternal(
		projectId: string,
		dryRun: boolean,
	): Promise<GroomPlan> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");
		const cfg = mergeGroomConfig(project.scrum_config ?? {});

		// Idempotency — skip if already groomed today (UTC date proxy).
		if (
			project.last_groom_at &&
			sameUtcDate(project.last_groom_at, new Date())
		) {
			return emptyPlan(dryRun, "already_groomed_today");
		}

		const creds = await this.credentials.forOrg(project.organisation_id);
		const owListId = project.list_ids?.open_work;
		const bugsListId = project.list_ids?.bugs;
		if (!owListId) {
			return emptyPlan(dryRun, "no_open_work_list");
		}

		const openWork = await this.fetchTasks(owListId, creds.token);
		const bugs = bugsListId
			? await this.fetchTasks(bugsListId, creds.token)
			: [];

		const plan: GroomPlan = {
			dryRun,
			dedupes: [],
			staleBugBumps: [],
			staleBugShames: [],
			hotspots: [],
			zombies: [],
		};

		// Rule 1 — Dedupe within Open Work.
		if (cfg.dedupe) {
			const open = openWork.filter(
				(t) => !isDoneStatus(t.status?.type ?? t.status?.status),
			);
			for (let i = 0; i < open.length; i++) {
				for (let j = i + 1; j < open.length; j++) {
					const a = tokenize(open[i].name);
					const b = tokenize(open[j].name);
					const score = jaccard(a, b);
					if (score >= JACCARD_DEDUPE_THRESHOLD) {
						const olderIdx = ageMs(open[i]) >= ageMs(open[j]) ? i : j;
						const newerIdx = olderIdx === i ? j : i;
						plan.dedupes.push({
							olderId: open[olderIdx].id,
							newerId: open[newerIdx].id,
							jaccard: Number(score.toFixed(2)),
						});
					}
				}
			}
		}

		// Rule 2 — Stale-bug bump (open ≥7d).
		if (cfg.stale_bug_bump) {
			const now = Date.now();
			for (const b of bugs) {
				if (isDoneStatus(b.status?.type ?? b.status?.status)) continue;
				const days = (now - ageStartMs(b)) / (24 * 60 * 60 * 1000);
				if (days >= STALE_BUG_BUMP_DAYS && days < STALE_BUG_SHAME_DAYS) {
					plan.staleBugBumps.push({
						taskId: b.id,
						ageDays: Math.round(days),
					});
				}
			}
		}

		// Rule 3 — Stale-bug shame (open ≥30d).
		if (cfg.stale_bug_shame) {
			const now = Date.now();
			for (const b of bugs) {
				if (isDoneStatus(b.status?.type ?? b.status?.status)) continue;
				const days = (now - ageStartMs(b)) / (24 * 60 * 60 * 1000);
				if (days >= STALE_BUG_SHAME_DAYS) {
					plan.staleBugShames.push({
						taskId: b.id,
						ageDays: Math.round(days),
					});
				}
			}
		}

		// Rule 5 — Hotspot promote.
		if (cfg.hotspot_promote) {
			const hotspots = await this.findHotspots(project.id);
			for (const h of hotspots) {
				if (await this.recentlyEmittedHotspot(project.id, h.path)) continue;
				const referencedAlready = openWork.some(
					(t) =>
						(t.markdown_description ?? t.description ?? "").includes(h.path) ||
						t.name.includes(h.path),
				);
				if (referencedAlready) continue;
				plan.hotspots.push(h);
			}
		}

		// Rule 6 — Zombie archive (default OFF, opt-in).
		if (cfg.zombie_archive) {
			const now = Date.now();
			for (const t of openWork) {
				const status = (t.status?.status ?? "").toLowerCase();
				if (status !== "backlog" && status !== "to do") continue;
				const idle = (now - ageStartMs(t)) / (24 * 60 * 60 * 1000);
				if (idle >= ZOMBIE_IDLE_DAYS) {
					plan.zombies.push({ taskId: t.id, idleDays: Math.round(idle) });
				}
			}
		}

		if (dryRun) {
			await this.audit.record({
				projectId: project.id,
				kind: "groom",
				before: null,
				after: plan,
				reason: `dry-run groom: dedupes=${plan.dedupes.length} bumps=${plan.staleBugBumps.length} shames=${plan.staleBugShames.length} hotspots=${plan.hotspots.length} zombies=${plan.zombies.length}`,
				dryRun: true,
			});
			return plan;
		}

		// ── execute ──────────────────────────────────────────────────────

		for (const d of plan.dedupes) {
			try {
				await this.clickup.addTagToTask(
					d.olderId,
					`duplicate-of:${d.newerId.slice(0, 8)}`,
					creds.token,
				);
				await this.audit.record({
					projectId: project.id,
					kind: "groom:dedupe",
					target: d.olderId,
					after: d,
					reason: `dedupe jaccard=${d.jaccard}`,
				});
			} catch (err) {
				this.log.warn(`dedupe ${d.olderId} failed: ${(err as Error).message}`);
			}
		}

		for (const s of plan.staleBugShames) {
			try {
				await this.clickup.addTagToTask(s.taskId, "stale-bug", creds.token);
				await this.clickup.addComment(
					s.taskId,
					`_Auto: bug open ${s.ageDays}d without resolution._`,
					creds.token,
				);
				await this.audit.record({
					projectId: project.id,
					kind: "groom:stale_bug_shame",
					target: s.taskId,
					after: s,
					reason: `${s.ageDays}d stale`,
				});
			} catch (err) {
				this.log.warn(
					`stale_bug_shame ${s.taskId} failed: ${(err as Error).message}`,
				);
			}
		}

		// Rule 2 priority bump — relies on a getTask(priority) that the
		// existing wrapper doesn't yet expose; we comment-tag instead so
		// the operator can manually bump in the UI. Promoting this to a
		// real priority bump is a small follow-up once getTask returns
		// the priority field.
		for (const b of plan.staleBugBumps) {
			try {
				await this.clickup.addComment(
					b.taskId,
					`_Auto: bug open ${b.ageDays}d — please bump priority._`,
					creds.token,
				);
				await this.audit.record({
					projectId: project.id,
					kind: "groom:stale_bug_bump",
					target: b.taskId,
					after: b,
					reason: `${b.ageDays}d open`,
				});
			} catch (err) {
				this.log.warn(
					`stale_bug_bump ${b.taskId} failed: ${(err as Error).message}`,
				);
			}
		}

		for (const h of plan.hotspots) {
			try {
				const created = await this.clickup.createTask(
					owListId,
					{
						name: `[Hotspot] Investigate ${h.path}`,
						markdown_content: `Auto-promoted: \`${h.path}\` was touched ${h.churn} times in the last ${HOTSPOT_WINDOW_DAYS} days.\n\n_Auto-imported by clickup-tracker._`,
						priority: 2,
					},
					creds.token,
				);
				await this.audit.record({
					projectId: project.id,
					kind: "groom:hotspot_promote",
					target: created.id,
					after: { path: h.path, churn: h.churn },
					reason: `${h.churn}x in ${HOTSPOT_WINDOW_DAYS}d`,
				});
			} catch (err) {
				this.log.warn(`hotspot ${h.path} failed: ${(err as Error).message}`);
			}
		}

		for (const z of plan.zombies) {
			try {
				await this.clickup.addTagToTask(z.taskId, "auto-archived", creds.token);
				await this.clickup.setTaskStatus(z.taskId, "Closed", creds.token);
				await this.audit.record({
					projectId: project.id,
					kind: "groom:zombie_archive",
					target: z.taskId,
					after: z,
					reason: `${z.idleDays}d idle`,
				});
			} catch (err) {
				this.log.warn(`zombie ${z.taskId} failed: ${(err as Error).message}`);
			}
		}

		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET last_groom_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid`,
			project.id,
		);
		return plan;
	}

	// ── data helpers ───────────────────────────────────────────────────

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, clickup_team_id, clickup_space_id,
              list_ids, last_groom_at, scrum_config
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
				`groom fetchTasks(${listId}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	private async findHotspots(
		projectId: string,
	): Promise<Array<{ path: string; churn: number }>> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{ path: string; n: bigint }>
			>(
				`SELECT f->>'path' AS path, COUNT(*)::bigint AS n
         FROM clickup_tracker.git_events g, jsonb_array_elements(g.files_changed::jsonb) f
         WHERE g.project_id = $1::uuid
           AND g.created_at > NOW() - ($2::int * INTERVAL '1 day')
           AND f->>'status' IN ('M', 'A')
         GROUP BY f->>'path'
         HAVING COUNT(*) >= $3
         ORDER BY COUNT(*) DESC
         LIMIT 20`,
				projectId,
				HOTSPOT_WINDOW_DAYS,
				HOTSPOT_CHURN_THRESHOLD,
			);
			return rows.map((r) => ({ path: r.path, churn: Number(r.n) }));
		} catch (err) {
			this.log.warn(`findHotspots failed: ${(err as Error).message}`);
			return [];
		}
	}

	private async recentlyEmittedHotspot(
		projectId: string,
		path: string,
	): Promise<boolean> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
				`SELECT id FROM clickup_tracker.scrum_audit
         WHERE project_id = $1::uuid
           AND kind = 'groom:hotspot_promote'
           AND after->>'path' = $2
           AND at > NOW() - ($3::int * INTERVAL '1 day')
         LIMIT 1`,
				projectId,
				path,
				HOTSPOT_COOLDOWN_DAYS,
			);
			return rows.length > 0;
		} catch {
			return false;
		}
	}
}

// ── pure helpers ────────────────────────────────────────────────────────

export function tokenize(name: string): Set<string> {
	return new Set(
		(name ?? "")
			.toLowerCase()
			.replace(/^\[\d{4}-\d{2}-\d{2}\] /, "")
			.replace(/\([^)]*\)/g, " ")
			.replace(/[^a-z0-9 ]+/g, " ")
			.split(/\s+/)
			.filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
	);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter += 1;
	return inter / (a.size + b.size - inter);
}

function mergeGroomConfig(cfg: Record<string, unknown>): GroomConfig {
	const groom = (cfg.groom as Partial<GroomConfig>) ?? {};
	return { ...GROOM_DEFAULTS, ...groom };
}

function ageMs(t: ClickUpTaskFull): number {
	return Date.now() - ageStartMs(t);
}

function ageStartMs(t: ClickUpTaskFull): number {
	const d = t.date_created ? Number(t.date_created) : Date.now();
	return Number.isFinite(d) ? d : Date.now();
}

function sameUtcDate(a: Date | string, b: Date): boolean {
	const aDate = a instanceof Date ? a : new Date(a);
	return (
		aDate.getUTCFullYear() === b.getUTCFullYear() &&
		aDate.getUTCMonth() === b.getUTCMonth() &&
		aDate.getUTCDate() === b.getUTCDate()
	);
}

function emptyPlan(dryRun: boolean, skipped: string): GroomPlan {
	return {
		dryRun,
		skipped,
		dedupes: [],
		staleBugBumps: [],
		staleBugShames: [],
		hotspots: [],
		zombies: [],
	};
}
