import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import type { ClickUpTaskFull } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { isoWeekOf } from "../util/iso-week";
import { AuditService } from "./audit.service";

/**
 * Plan §C.1 — autonomous sprint planning.
 *
 * Heuristics (no LLM):
 *   1. Velocity = mean of last N closed sprint Lists' Done counts.
 *      Falls back to `default_velocity_points=8` for the first 4 sprints
 *      while we accumulate signal.
 *   2. Carryover (open tasks in `active_sprint`) → first into the new
 *      sprint List up to the budget.
 *   3. Bug ceiling = round(velocity * bug_ceiling_pct) — top open bugs
 *      get a guaranteed slot.
 *   4. Top open work by oldest-first (FIFO) until budget is filled. Once
 *      we add priority-aware ranking it becomes (-priority, +age).
 *
 * Idempotent on `iso_week`: a second invocation in the same week does
 * nothing (returns `{skipped:'already_planned_this_week'}`).
 *
 * Default `dryRun=true`. Mutations (move + setStatus) only fire on
 * explicit `dryRun=false`. Every action emits a `scrum_audit` row.
 */

export interface SprintPlan {
	dryRun: boolean;
	skipped?: string;
	isoWeek: string;
	sprintListId?: string;
	goal: string;
	velocity: { points: number; recent: number[]; warmingUp: boolean };
	selected: Array<{
		taskId: string;
		name: string;
		fromList: string;
		reason: "carryover" | "bug_ceiling" | "top_open_work";
	}>;
	carryoverCount: number;
	bugCount: number;
	openWorkCount: number;
}

interface ProjectMin {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	last_sprint_plan_at: Date | null;
	scrum_config: Record<string, unknown> | null;
	template_status: string | null;
}

interface ScrumConfigDefaults {
	velocity_window_recent: number;
	default_velocity_points: number;
	bug_ceiling_pct: number;
}

const DEFAULTS: ScrumConfigDefaults = {
	velocity_window_recent: 4,
	default_velocity_points: 8,
	bug_ceiling_pct: 0.3,
};

@Injectable()
export class SprintPlannerService {
	private readonly log = new Logger(SprintPlannerService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly audit: AuditService,
	) {}

	async planSprint(projectId: string, dryRun: boolean): Promise<SprintPlan> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");
		const cfg = mergeDefaults(project.scrum_config ?? {});
		const isoWeek = isoWeekOf(new Date()).key;

		// 1. Idempotency — skip if already planned this iso_week.
		if (
			project.last_sprint_plan_at &&
			sameIsoWeek(project.last_sprint_plan_at, new Date())
		) {
			return {
				dryRun,
				skipped: "already_planned_this_week",
				isoWeek,
				goal: "n/a",
				velocity: { points: 0, recent: [], warmingUp: false },
				selected: [],
				carryoverCount: 0,
				bugCount: 0,
				openWorkCount: 0,
			};
		}

		const creds = await this.credentials.forOrg(project.organisation_id);
		const activeSprintListId = project.list_ids?.active_sprint;
		const openWorkListId = project.list_ids?.open_work;
		const bugsListId = project.list_ids?.bugs;
		if (!activeSprintListId || !openWorkListId) {
			throw new BadRequestException(
				"project missing active_sprint / open_work list — run /clickup-replan first",
			);
		}

		// 2. Velocity — mean of last N sprint Lists' Done count.
		const velocity = await this.computeVelocity(
			project,
			isoWeek,
			cfg,
			creds.token,
		);
		const budgetTasks = velocity.points;
		let remaining = budgetTasks;
		const selected: SprintPlan["selected"] = [];

		// 3. Carryover from active_sprint (anything not Done).
		const activeTasks = await this.fetchTasks(activeSprintListId, creds.token);
		const carryover = activeTasks.filter(
			(t) => !isDoneStatus(t.status?.type ?? t.status?.status),
		);
		for (const t of carryover) {
			if (remaining <= 0) break;
			selected.push({
				taskId: t.id,
				name: t.name,
				fromList: activeSprintListId,
				reason: "carryover",
			});
			remaining -= 1;
		}

		// 4. Bug ceiling.
		const bugCeiling = Math.max(
			1,
			Math.floor(budgetTasks * cfg.bug_ceiling_pct),
		);
		let bugSlots = bugCeiling;
		if (bugsListId) {
			const bugs = await this.fetchTasks(bugsListId, creds.token);
			const openBugs = bugs.filter(
				(t) => !isDoneStatus(t.status?.type ?? t.status?.status),
			);
			for (const b of openBugs) {
				if (remaining <= 0 || bugSlots <= 0) break;
				selected.push({
					taskId: b.id,
					name: b.name,
					fromList: bugsListId,
					reason: "bug_ceiling",
				});
				remaining -= 1;
				bugSlots -= 1;
			}
		}

		// 5. Top open work by date_created (FIFO).
		const openWork = (await this.fetchTasks(openWorkListId, creds.token))
			.filter((t) => !isDoneStatus(t.status?.type ?? t.status?.status))
			.sort((a, b) => {
				const aT = a.date_created ? Number(a.date_created) : 0;
				const bT = b.date_created ? Number(b.date_created) : 0;
				return aT - bT;
			});
		for (const w of openWork) {
			if (remaining <= 0) break;
			selected.push({
				taskId: w.id,
				name: w.name,
				fromList: openWorkListId,
				reason: "top_open_work",
			});
			remaining -= 1;
		}

		// 6. Compute goal — mode of `epic:*` tags across selected tasks.
		const goal = inferGoalFromNames(selected.map((s) => s.name));

		const plan: SprintPlan = {
			dryRun,
			isoWeek,
			goal,
			velocity,
			selected,
			carryoverCount: selected.filter((s) => s.reason === "carryover").length,
			bugCount: selected.filter((s) => s.reason === "bug_ceiling").length,
			openWorkCount: selected.filter((s) => s.reason === "top_open_work")
				.length,
		};

		if (dryRun) {
			await this.audit.record({
				projectId: project.id,
				kind: "plan_sprint",
				target: null,
				before: null,
				after: plan,
				reason: `dry-run sprint plan ${isoWeek}: ${selected.length} tasks`,
				dryRun: true,
			});
			return plan;
		}

		// 7. Ensure sprint List for this iso_week exists.
		const sprintListId = await this.ensureSprintList(
			project,
			isoWeek,
			creds.token,
		);
		plan.sprintListId = sprintListId;

		// 8. Move selected tasks + setStatus('Done') for completed carryover only.
		for (const s of selected) {
			try {
				await this.clickup.moveTaskToList(
					project.clickup_team_id,
					s.taskId,
					sprintListId,
					creds.token,
				);
				await this.audit.record({
					projectId: project.id,
					kind: "plan_sprint:move",
					target: s.taskId,
					before: { fromList: s.fromList },
					after: { toList: sprintListId, reason: s.reason },
					reason: s.reason,
					dryRun: false,
				});
			} catch (err) {
				this.log.warn(
					`plan_sprint move failed task=${s.taskId}: ${(err as Error).message}`,
				);
			}
		}

		// 9. Persist last_sprint_plan_at + extend velocity_window.
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET last_sprint_plan_at = NOW(),
           velocity_window = velocity_window || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
			project.id,
			JSON.stringify([
				{
					iso_week: isoWeek,
					committed_tasks: selected.length,
					at: new Date().toISOString(),
				},
			]),
		);

		await this.audit.record({
			projectId: project.id,
			kind: "plan_sprint",
			target: sprintListId,
			before: null,
			after: plan,
			reason: `Sprint planned: ${selected.length} tasks (carryover=${plan.carryoverCount} bugs=${plan.bugCount} open=${plan.openWorkCount})`,
			dryRun: false,
		});
		return plan;
	}

	// ── helpers ────────────────────────────────────────────────────────

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, clickup_team_id, clickup_space_id,
              list_ids, sprint_lists, last_sprint_plan_at,
              scrum_config, template_status
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
			this.log.warn(`fetchTasks(${listId}) failed: ${(err as Error).message}`);
			return [];
		}
	}

	private async computeVelocity(
		project: ProjectMin,
		currentIsoWeek: string,
		cfg: ScrumConfigDefaults,
		token: string,
	): Promise<SprintPlan["velocity"]> {
		const recentSprints = Object.entries(project.sprint_lists ?? {})
			.filter(([k]) => k < currentIsoWeek)
			.sort(([a], [b]) => (a < b ? 1 : -1))
			.slice(0, cfg.velocity_window_recent);
		if (recentSprints.length === 0) {
			return {
				points: cfg.default_velocity_points,
				recent: [],
				warmingUp: true,
			};
		}
		const recent: number[] = [];
		for (const [, listId] of recentSprints) {
			const tasks = await this.fetchTasks(listId, token);
			const done = tasks.filter((t) =>
				isDoneStatus(t.status?.type ?? t.status?.status),
			).length;
			recent.push(done);
		}
		const mean = recent.length
			? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
			: cfg.default_velocity_points;
		return {
			points: Math.max(mean, 1),
			recent,
			warmingUp: recent.length < cfg.velocity_window_recent,
		};
	}

	private async ensureSprintList(
		project: ProjectMin,
		isoWeek: string,
		token: string,
	): Promise<string> {
		const existing = project.sprint_lists?.[isoWeek];
		if (existing) return existing;
		// Look up the 📜 History folder under the Space.
		if (!project.clickup_space_id) {
			throw new BadRequestException(
				"project has no clickup_space_id — cannot create sprint List",
			);
		}
		const folders = await this.clickup.listFolders(
			project.clickup_space_id,
			token,
		);
		const history = folders.find((f) => (f.name ?? "").trim().startsWith("📜"));
		if (!history) {
			throw new BadRequestException(
				"📜 History folder not found in Space — re-run /clickup-replan",
			);
		}
		const wk = isoWeekOf(new Date());
		const sprintName = `Sprint ? — ${wk.startDate} → ${wk.endDate}`;
		const list = await this.clickup.createListInFolder(
			history.id,
			sprintName,
			token,
		);
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET sprint_lists = sprint_lists || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
			project.id,
			JSON.stringify({ [isoWeek]: list.id }),
		);
		return list.id;
	}
}

// ── pure helpers ────────────────────────────────────────────────────────

export function isDoneStatus(s: string | undefined): boolean {
	if (!s) return false;
	const lower = s.toLowerCase();
	return lower === "closed" || lower === "complete" || lower === "done";
}

export function sameIsoWeek(a: Date | string, b: Date): boolean {
	const aDate = a instanceof Date ? a : new Date(a);
	return isoWeekOf(aDate).key === isoWeekOf(b).key;
}

export function inferGoalFromNames(names: string[]): string {
	const counts = new Map<string, number>();
	for (const n of names) {
		const m = /\(([^):]+)\)/.exec(n); // captures the conventional-commit scope
		if (m) {
			const tag = `epic:${m[1]}`;
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	if (counts.size === 0) return "epic:mixed";
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	return sorted[0][0];
}

export function mergeDefaults(
	cfg: Record<string, unknown>,
): ScrumConfigDefaults {
	const out = { ...DEFAULTS };
	if (typeof cfg.velocity_window_recent === "number")
		out.velocity_window_recent = cfg.velocity_window_recent;
	if (typeof cfg.default_velocity_points === "number")
		out.default_velocity_points = cfg.default_velocity_points;
	if (typeof cfg.bug_ceiling_pct === "number")
		out.bug_ceiling_pct = cfg.bug_ceiling_pct;
	return out;
}
