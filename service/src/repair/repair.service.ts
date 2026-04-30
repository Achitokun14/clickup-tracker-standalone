import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { isoWeekOf } from "../util/iso-week";

/**
 * Plan §A.4 — Bug 4 cleanup. Walks the In Review + Active Sprint + every
 * historical Sprint List, groups tasks by parsed name pattern
 * `[YYYY-MM-DD] type(scope): subject`, archives non-canonical duplicates
 * (those NOT in `task_index['commit:<sha>']`), and moves any survivor in
 * `In Review` whose underlying `git_events.branch == git_default_branch`
 * to the current sprint List + status='Done'.
 *
 * Default `dryRun=true`. Idempotent on repeat invocation.
 */
export interface RepairPlan {
	dryRun: boolean;
	candidatesScanned: number;
	groupsScanned: number;
	archive: Array<{ taskId: string; name: string; listId: string }>;
	move: Array<{
		taskId: string;
		name: string;
		fromList: string;
		toList: string;
	}>;
	errors: Array<{ op: string; taskId?: string; message: string }>;
}

interface ProjectMin {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	git_default_branch: string | null;
}

const NAME_RE = /^\[(\d{4}-\d{2}-\d{2})\] (\w+)\((.*?)\): (.+)$/;

@Injectable()
export class RepairService {
	private readonly log = new Logger(RepairService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async repairRouting(projectId: string, dryRun: boolean): Promise<RepairPlan> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");
		const creds = await this.credentials.forOrg(project.organisation_id);

		const candidateLists = [
			project.list_ids?.in_review,
			project.list_ids?.active_sprint,
			...Object.values(project.sprint_lists ?? {}),
		].filter((id): id is string => Boolean(id));

		const errors: RepairPlan["errors"] = [];
		const tasksByList = new Map<string, Array<{ id: string; name: string }>>();
		let candidatesScanned = 0;
		for (const listId of candidateLists) {
			try {
				const tasks = await this.clickup.listTasksInList(listId, creds.token);
				tasksByList.set(
					listId,
					tasks.map((t) => ({ id: t.id, name: t.name ?? "" })),
				);
				candidatesScanned += tasks.length;
			} catch (err) {
				errors.push({
					op: "listTasksInList",
					message: `${listId}: ${(err as Error).message}`,
				});
			}
		}

		// Group by parsed-name signature (date + type + scope + cleanSubject)
		type Item = { listId: string; id: string; name: string };
		const groups = new Map<string, Item[]>();
		for (const [listId, tasks] of tasksByList) {
			for (const t of tasks) {
				const m = t.name.match(NAME_RE);
				if (!m) continue;
				const key = `${m[1]}|${m[2]}|${m[3]}|${m[4].trim()}`;
				const arr = groups.get(key) ?? [];
				arr.push({ listId, id: t.id, name: t.name });
				groups.set(key, arr);
			}
		}

		// Step 3 — archive duplicates (keep the one in task_index)
		const indexValues = new Set(Object.values(project.task_index ?? {}));
		const archive: RepairPlan["archive"] = [];
		for (const items of groups.values()) {
			if (items.length <= 1) continue;
			const canonical = items.find((i) => indexValues.has(i.id)) ?? items[0];
			for (const i of items) {
				if (i.id === canonical.id) continue;
				archive.push({ taskId: i.id, name: i.name, listId: i.listId });
			}
		}

		// Step 4 — surviving In Review tasks on default branch → move + Done
		const inReviewListId = project.list_ids?.in_review;
		const archivedIds = new Set(archive.map((a) => a.taskId));
		const move: RepairPlan["move"] = [];
		const currentIsoWeek = isoWeekOf(new Date()).key;
		const currentSprintListId = project.sprint_lists?.[currentIsoWeek];
		const defaultBranch = project.git_default_branch ?? "main";

		if (inReviewListId && currentSprintListId) {
			// Reverse-map task_id → sha for the In-Review tasks we're considering
			const taskIdToSha = new Map<string, string>();
			for (const [k, v] of Object.entries(project.task_index ?? {})) {
				if (k.startsWith("commit:") && !k.includes(":file:")) {
					taskIdToSha.set(v, k.slice("commit:".length));
				}
			}
			const inReviewItems = (tasksByList.get(inReviewListId) ?? []).filter(
				(t) => !archivedIds.has(t.id),
			);
			// Bulk-fetch branches for the SHAs we know
			const shas = inReviewItems
				.map((t) => taskIdToSha.get(t.id))
				.filter((s): s is string => Boolean(s));
			const shaToBranch = await this.fetchBranchesForShas(project.id, shas);
			for (const t of inReviewItems) {
				const sha = taskIdToSha.get(t.id);
				if (!sha) continue;
				const branch = shaToBranch.get(sha);
				if (branch === defaultBranch) {
					move.push({
						taskId: t.id,
						name: t.name,
						fromList: inReviewListId,
						toList: currentSprintListId,
					});
				}
			}
		}

		const plan: RepairPlan = {
			dryRun,
			candidatesScanned,
			groupsScanned: groups.size,
			archive,
			move,
			errors,
		};

		if (dryRun) return plan;

		// Execute archives first (so duplicates don't get moved by the move step)
		for (const a of archive) {
			try {
				await this.clickup.archiveTask(a.taskId, creds.token);
			} catch (err) {
				errors.push({
					op: "archiveTask",
					taskId: a.taskId,
					message: (err as Error).message,
				});
			}
		}

		// Execute moves: move + setStatus('Done')
		// (Status name 'Done' here is the post-template-configured literal; for
		//  inline-fallback we rely on lifecycle to coerce — repair-routing is
		//  meant to be run AFTER /clickup-template-configured anyway.)
		for (const m of move) {
			try {
				await this.clickup.moveTaskToList(
					project.clickup_team_id,
					m.taskId,
					m.toList,
					creds.token,
				);
				await this.clickup.setTaskStatus(m.taskId, "Done", creds.token);
			} catch (err) {
				errors.push({
					op: "moveTaskToList",
					taskId: m.taskId,
					message: (err as Error).message,
				});
			}
		}

		return plan;
	}

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, clickup_team_id, clickup_space_id,
              list_ids::jsonb AS list_ids,
              sprint_lists::jsonb AS sprint_lists,
              task_index::jsonb AS task_index,
              git_default_branch
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async fetchBranchesForShas(
		projectId: string,
		shas: string[],
	): Promise<Map<string, string>> {
		if (shas.length === 0) return new Map();
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{ commit_sha: string; branch: string | null }>
		>(
			`SELECT commit_sha, branch
       FROM clickup_tracker.git_events
       WHERE project_id = $1::uuid AND commit_sha = ANY($2::text[])`,
			projectId,
			shas,
		);
		return new Map(
			rows
				.filter((r) => r.branch)
				.map((r) => [r.commit_sha, r.branch as string]),
		);
	}
}
