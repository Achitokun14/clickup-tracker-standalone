import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { eventsTotal } from "../metrics/registry";
import { PrismaService } from "../prisma/prisma.service";
import { SyncService } from "../sync/sync.service";
import {
	mapInlineStatus,
	planSpaceCommitTask,
	sprintListKey,
} from "../bulk/hierarchy";
import type {
	CommitRecord,
	CommitFileChange,
} from "../extractors/git-history.extractor";
import { isoWeekOf } from "../util/iso-week";
import { parseGitRemote, type ParsedGitRemote } from "../util/git-remote-parse";
import { normalizeAuthor } from "../util/classify";
import { normaliseScope, parseConventional } from "./conventional";
import type { GitEventDto, PromptEventDto } from "./dto/git-event.dto";

export interface EventReceipt {
	eventId: string;
	replayed: boolean;
	actionsCount: number;
	actions: ResultingAction[];
}

export type ResultingAction =
	| { kind: "skipped"; reason: string }
	| { kind: "replayed" }
	| {
			kind: "create_task";
			task_id: string;
			list_key: string;
			source?: string;
	  }
	| { kind: "close_task"; task_id: string; reason?: string }
	| { kind: "start_task"; task_id: string }
	| { kind: "comment"; task_id: string }
	| {
			kind: "move_task";
			task_id: string;
			from_list_key?: string;
			to_list_key: string;
	  }
	| { kind: "conflict_skipped"; task_id: string };

interface ProjectMin {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	clickup_folder_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	scope_config: { mode?: string; paths?: string[] };
	git_default_branch: string | null;
	git_remote_url: string | null;
	git_remote_host: string | null;
	git_remote_owner_repo: string | null;
	template_status: string | null;
}

@Injectable()
export class EventsService {
	private readonly log = new Logger(EventsService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly sync: SyncService,
	) {}

	// ── git events ─────────────────────────────────────────────

	async ingestGit(
		projectId: string,
		dto: GitEventDto,
		idempotencyKey?: string,
		source?: string,
	): Promise<EventReceipt> {
		const dedupeKey = `git:${projectId}:${dto.commit_sha}${idempotencyKey ? `:${idempotencyKey}` : ""}`;

		// 1. Idempotency.
		const replayed = await this.checkAndMark(dedupeKey, "git");
		if (replayed) {
			eventsTotal.inc({ kind: "git", outcome: "replayed" });
			return {
				eventId: "",
				replayed: true,
				actionsCount: 0,
				actions: [{ kind: "replayed" }],
			};
		}

		// 2. Load project.
		const project = await this.loadProject(projectId);
		if (!project) {
			throw new Error("project not found (post-HMAC; race condition?)");
		}

		// 3. Persist git_events row (always — even if scope filter rejects).
		const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
			`INSERT INTO clickup_tracker.git_events (
        project_id, commit_sha, branch, author, committer_email,
        committed_at, message, files_changed, todo_diffs, resulting_actions
      )
      VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7, $8::jsonb, $9::jsonb, '[]'::jsonb)
      ON CONFLICT (project_id, commit_sha) DO UPDATE SET message = EXCLUDED.message
      RETURNING id`,
			project.id,
			dto.commit_sha,
			dto.branch ?? null,
			dto.author ?? null,
			dto.committer_email ?? null,
			dto.committed_at ?? null,
			dto.message,
			JSON.stringify(dto.files_changed ?? []),
			JSON.stringify(dto.todo_diffs ?? []),
		);
		const eventId = inserted[0].id;

		// 4. Conventional-commit + clickup-skip handling.
		const cc = parseConventional(dto.message);
		const actions: ResultingAction[] = [];

		if (cc.hasSkipMarker) {
			actions.push({ kind: "skipped", reason: "clickup-skip marker present" });
			await this.persistActions(eventId, actions);
			return { eventId, replayed: false, actionsCount: 0, actions };
		}

		// 5. scope_config subdir filter — if the project tracks only a subset of
		// paths and zero files in this commit fall under it, record the event but
		// skip ClickUp emission entirely.
		if (!this.passesScopeFilter(project, dto.files_changed ?? [])) {
			actions.push({ kind: "skipped", reason: "scope_config_no_match" });
			await this.persistActions(eventId, actions);
			eventsTotal.inc({ kind: "git", outcome: "scope_filtered" });
			return { eventId, replayed: false, actionsCount: 0, actions };
		}

		// 6. Resolve credentials.
		let creds: Awaited<ReturnType<typeof this.credentials.forOrg>> | null =
			null;
		try {
			creds = await this.credentials.forOrg(project.organisation_id);
		} catch (err) {
			this.log.warn(
				`no credentials for org ${project.organisation_id}: ${(err as Error).message}`,
			);
			actions.push({ kind: "skipped", reason: "no_clickup_credentials" });
			await this.persistActions(eventId, actions);
			return { eventId, replayed: false, actionsCount: 0, actions };
		}

		// 7. TODO diffs first — orthogonal to commit-task creation.
		await this.handleTodoDiffs(project, dto, source ?? "human", actions, creds);

		// 8. Commit task — modern per-repo Space behaviour. Falls through quietly
		// if the project hasn't been backfilled yet (no sprint Lists provisioned).
		const useSpace = this.hasSpaceLists(project);
		if (useSpace) {
			await this.handleCommitForSpace(
				project,
				dto,
				cc,
				source ?? "human",
				actions,
				creds,
			);
		} else {
			// Legacy 3-list project: keep the comment-on-overview behaviour so
			// existing installs don't break before they're re-registered.
			await this.handleCommitForLegacy(project, dto, cc, actions, creds);
		}

		// 9. Persist + bookkeeping.
		await this.persistActions(eventId, actions);
		await this.touchLastSync(project.id);
		eventsTotal.inc({ kind: "git", outcome: "processed" });
		return { eventId, replayed: false, actionsCount: actions.length, actions };
	}

	// ── prompt events ──────────────────────────────────────────

	async ingestPrompt(
		projectId: string,
		dto: PromptEventDto,
		idempotencyKey?: string,
		_source?: string,
	): Promise<EventReceipt> {
		const dedupeKey = `prompt:${projectId}:${idempotencyKey ?? Date.now()}`;
		const replayed = await this.checkAndMark(dedupeKey, "prompt");
		if (replayed) {
			eventsTotal.inc({ kind: "prompt", outcome: "replayed" });
			return {
				eventId: "",
				replayed: true,
				actionsCount: 0,
				actions: [{ kind: "replayed" }],
			};
		}

		const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
			`INSERT INTO clickup_tracker.prompt_events (
        project_id, session_id, prompt_excerpt, outcome_summary, files_touched, resulting_actions
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, '[]'::jsonb)
      RETURNING id`,
			projectId,
			dto.session_id ?? null,
			truncate(dto.prompt_excerpt ?? "", 1000),
			truncate(dto.outcome_summary ?? "", 1000),
			JSON.stringify(dto.files_touched ?? []),
		);

		const eventId = inserted[0].id;
		await this.sync.enqueue({ projectId, kind: "prompt", eventId });
		eventsTotal.inc({ kind: "prompt", outcome: "queued" });
		return { eventId, replayed: false, actionsCount: 0, actions: [] };
	}

	// ── per-repo Space lifecycle ──────────────────────────────

	private async handleCommitForSpace(
		project: ProjectMin,
		dto: GitEventDto,
		cc: ReturnType<typeof parseConventional>,
		source: string,
		actions: ResultingAction[],
		creds: { token: string; team_id: string },
	): Promise<void> {
		// 1. Build a synthetic CommitRecord so the lifecycle path runs through
		// the *exact same* planner as backfill (planSpaceCommitTask).
		const author = dto.author ?? "";
		const committedAt = dto.committed_at ?? new Date().toISOString();
		const week = isoWeekOf(new Date(committedAt));
		const filesChanged: CommitFileChange[] = (dto.files_changed ?? []).map(
			(f) => ({
				path: f.path,
				additions: f.additions ?? 0,
				deletions: f.deletions ?? 0,
				status: mapFileStatus(f.status),
			}),
		);
		const remote: ParsedGitRemote | null =
			project.git_remote_host && project.git_remote_owner_repo
				? {
						host: project.git_remote_host,
						ownerRepo: project.git_remote_owner_repo,
					}
				: project.git_remote_url
					? parseGitRemote(project.git_remote_url)
					: null;

		const commit: CommitRecord = {
			sha: dto.commit_sha,
			parents: [],
			author: {
				name: author,
				email: dto.committer_email ?? "",
				date: committedAt,
			},
			committer: {
				name: author,
				email: dto.committer_email ?? "",
				date: committedAt,
			},
			refs: dto.branch ? [dto.branch, `origin/${dto.branch}`] : [],
			branch: dto.branch ?? null,
			subject: cc.subject || dto.message.split("\n")[0],
			body: cc.body,
			type: mapCcTypeToBgmt(cc.type) ?? "Chore",
			scope: cc.scope ?? null,
			filesChanged,
			isMergeCommit: /^Merge\b/i.test(dto.message),
			sprintKey: week.key,
			sprintOrdinal: 0,
			sprintRange: { startDate: week.startDate, endDate: week.endDate },
		};
		const planned = planSpaceCommitTask(
			commit,
			project.git_default_branch ?? "main",
			remote,
			source,
		);

		// 2. Idempotency — never re-create if the task_index already maps the SHA.
		const existingId = project.task_index[planned.key];
		if (existingId) {
			actions.push({
				kind: "comment",
				task_id: existingId,
			});
			return;
		}

		// 3. Resolve list. Plan emits sprintListKey or "in_review"; fall back to
		// active_sprint, then open_work, if the requested list isn't provisioned.
		const requestedKey = planned.listKey;
		const listId =
			project.list_ids[requestedKey] ??
			project.sprint_lists[stripSprintPrefix(requestedKey)] ??
			project.list_ids["active_sprint"] ??
			project.list_ids["open_work"];
		if (!listId) {
			this.log.warn(
				`no list resolved for commit ${dto.commit_sha} (wanted ${requestedKey})`,
			);
			actions.push({
				kind: "skipped",
				reason: `no_list_for_${requestedKey}`,
			});
			return;
		}
		const resolvedKey =
			project.list_ids[requestedKey] !== undefined
				? requestedKey
				: project.sprint_lists[stripSprintPrefix(requestedKey)] !== undefined
					? requestedKey
					: project.list_ids["active_sprint"] !== undefined
						? "active_sprint"
						: "open_work";

		// 4. Create task with native fields.
		const statusForCu =
			project.template_status === "configured"
				? planned.status
				: mapInlineStatus(planned.status);
		try {
			const created = await this.clickup.createTask(
				listId,
				{
					name: planned.name,
					markdown_content: planned.markdown_content,
					status: statusForCu,
					tags: planned.tags,
					priority: planned.priority,
					start_date: planned.startDateMs,
					due_date: planned.dueDateMs,
					points: planned.points,
					time_estimate: planned.timeEstimateMs,
					notify_all: false,
				},
				creds.token,
			);
			await this.appendToTaskIndex(project.id, { [planned.key]: created.id });
			project.task_index[planned.key] = created.id;
			actions.push({
				kind: "create_task",
				task_id: created.id,
				list_key: resolvedKey,
				source: `git:${dto.commit_sha}`,
			});
		} catch (err) {
			this.log.warn(`createTask (commit) failed: ${(err as Error).message}`);
			actions.push({ kind: "skipped", reason: "create_task_failed" });
			return;
		}

		// 5. Conventional-verb side-effects.
		if (cc.type === "fix" && cc.scope) {
			await this.tryCloseTaskByScope(
				project,
				cc.scope,
				`Fixed in ${dto.commit_sha.slice(0, 8)}: ${cc.subject}`,
				"Verifying",
				actions,
				creds.token,
			);
		} else if (cc.type === "feat" && cc.scope) {
			await this.tryCloseTaskByScope(
				project,
				cc.scope,
				`Implemented in ${dto.commit_sha.slice(0, 8)}: ${cc.subject}`,
				"Done",
				actions,
				creds.token,
			);
		}

		// 6. Merge-into-default detection — move the original branch task to the
		// active sprint List + transition to Done.
		if (commit.isMergeCommit && this.isOnDefaultBranch(project, dto)) {
			await this.tryAdvanceMergedReviewTasks(
				project,
				dto,
				actions,
				creds.token,
			);
		}
	}

	private async handleCommitForLegacy(
		project: ProjectMin,
		dto: GitEventDto,
		cc: ReturnType<typeof parseConventional>,
		actions: ResultingAction[],
		creds: { token: string; team_id: string },
	): Promise<void> {
		// Legacy projects only have list_ids.{overview, open_work, history} +
		// the original "comment summary on overview" UX. Preserved verbatim so
		// installs that haven't been re-registered keep working.
		const overviewId = project.task_index["overview"];
		if (!overviewId) return;
		try {
			const lines = [
				`### ${cc.type ?? "commit"}${cc.scope ? `(${cc.scope})` : ""}: ${cc.subject}`,
				"",
				`\`${dto.commit_sha.slice(0, 8)}\` by ${dto.author ?? "unknown"} on ${dto.committed_at ?? "now"}`,
			];
			if (cc.body) lines.push("", cc.body);
			await this.clickup.addComment(overviewId, lines.join("\n"), creds.token);
			actions.push({ kind: "comment", task_id: overviewId });
		} catch {
			/* swallow */
		}
	}

	private async handleTodoDiffs(
		project: ProjectMin,
		dto: GitEventDto,
		source: string,
		actions: ResultingAction[],
		creds: { token: string; team_id: string },
	): Promise<void> {
		const openWorkListId =
			project.list_ids["open_work"] ?? project.list_ids.open_work;
		if (!openWorkListId) return;
		for (const diff of dto.todo_diffs ?? []) {
			const todoKey = `todo:${diff.file}:${diff.line ?? "?"}`;
			if (diff.op === "add") {
				if (project.task_index[todoKey]) continue;
				try {
					const task = await this.clickup.createTask(
						openWorkListId,
						{
							name: `${diff.marker}: ${truncate(diff.text, 80)}`,
							markdown_content: this.todoDescription(diff, dto.commit_sha),
							tags: ["general", `type:chore`, `source:${kebab(source)}`].sort(),
							notify_all: false,
						},
						creds.token,
					);
					await this.appendToTaskIndex(project.id, { [todoKey]: task.id });
					project.task_index[todoKey] = task.id;
					actions.push({
						kind: "create_task",
						task_id: task.id,
						list_key: "open_work",
						source: `git:${dto.commit_sha}`,
					});
				} catch (err) {
					this.log.warn(`createTask (todo) failed: ${(err as Error).message}`);
				}
			} else if (diff.op === "remove") {
				const existing = project.task_index[todoKey];
				if (!existing) continue;
				try {
					await this.clickup.addComment(
						existing,
						`Resolved by ${dto.commit_sha.slice(0, 8)}${dto.author ? ` (${dto.author})` : ""}`,
						creds.token,
					);
					// Real status transition now (was comment-only in the legacy path).
					try {
						await this.clickup.setTaskStatus(existing, "Done", creds.token);
					} catch (err) {
						this.log.debug(
							`setTaskStatus(Done) on todo ${existing} failed: ${(err as Error).message}`,
						);
					}
					actions.push({
						kind: "close_task",
						task_id: existing,
						reason: "todo_removed",
					});
				} catch (err) {
					this.log.warn(`addComment failed: ${(err as Error).message}`);
				}
			}
		}
	}

	private async tryCloseTaskByScope(
		project: ProjectMin,
		scope: string,
		comment: string,
		status: string,
		actions: ResultingAction[],
		token: string,
	): Promise<void> {
		const taskId = this.findTaskByScope(project, scope);
		if (!taskId) return;
		try {
			await this.clickup.addComment(taskId, comment, token);
		} catch {
			/* swallow */
		}
		try {
			await this.clickup.setTaskStatus(taskId, status, token);
			actions.push({
				kind: status === "Done" ? "close_task" : "comment",
				task_id: taskId,
				reason: `verb_${status.toLowerCase()}`,
			} as ResultingAction);
		} catch (err) {
			this.log.debug(
				`setTaskStatus(${status}) on ${taskId} failed: ${(err as Error).message}`,
			);
		}
	}

	private async tryAdvanceMergedReviewTasks(
		project: ProjectMin,
		dto: GitEventDto,
		actions: ResultingAction[],
		token: string,
	): Promise<void> {
		// Best-effort: scan the message body for "Merge pull request #N" style
		// references; if we have a recent In Review task with the same scope,
		// move + close it. Cheap heuristic — Session 6 can refine.
		const inReviewListId = project.list_ids["in_review"];
		const activeListId = project.list_ids["active_sprint"];
		if (!inReviewListId || !activeListId) return;

		// We don't have a direct mapping from merge-commit → original branch SHA
		// without traversing parents. Without parents in the DTO, we conservatively
		// skip the move and let the orchestrator's next replan reconcile.
		if (!project.clickup_team_id) return;
		this.log.debug(
			`merge ${dto.commit_sha.slice(0, 8)} on default branch — review-task advance is replan-bound`,
		);
		actions.push({ kind: "comment", task_id: activeListId });
	}

	// ── helpers ─────────────────────────────────────────────────

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, display_name, clickup_team_id,
              clickup_space_id, clickup_folder_id,
              list_ids::jsonb AS list_ids,
              COALESCE(sprint_lists, '{}'::jsonb)::jsonb AS sprint_lists,
              task_index::jsonb AS task_index,
              scope_config::jsonb AS scope_config,
              git_default_branch, git_remote_url,
              git_remote_host, git_remote_owner_repo,
              template_status
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async checkAndMark(key: string, kind: string): Promise<boolean> {
		const result = await this.prisma.$queryRawUnsafe<
			Array<{ inserted: boolean }>
		>(
			`INSERT INTO clickup_tracker.processed_events (event_id, kind)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING true AS inserted`,
			key,
			kind,
		);
		return result.length === 0;
	}

	private async persistActions(
		eventId: string,
		actions: ResultingAction[],
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.git_events
       SET resulting_actions = $2::jsonb, processed_at = NOW()
       WHERE id = $1::uuid`,
			eventId,
			JSON.stringify(actions),
		);
	}

	private async appendToTaskIndex(
		projectId: string,
		additions: Record<string, string>,
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET task_index = task_index || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
			projectId,
			JSON.stringify(additions),
		);
	}

	private async touchLastSync(projectId: string): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid`,
			projectId,
		);
	}

	private hasSpaceLists(project: ProjectMin): boolean {
		// Per-repo Space registrations populate active_sprint or in_review keys.
		// Legacy 3-list projects only have overview/open_work/history.
		return (
			!!project.list_ids["active_sprint"] ||
			!!project.list_ids["in_review"] ||
			Object.keys(project.sprint_lists ?? {}).length > 0
		);
	}

	private passesScopeFilter(
		project: ProjectMin,
		files: GitEventDto["files_changed"],
	): boolean {
		const sc = project.scope_config ?? {};
		const mode = sc.mode ?? "root";
		if (mode !== "subdir") return true;
		const paths = (sc.paths ?? []).map((p) => p.replace(/\/+$/, "") + "/");
		if (paths.length === 0) return true; // misconfigured — pass-through
		for (const f of files ?? []) {
			const norm = f.path.replace(/^\.?\/+/, "");
			if (paths.some((p) => norm.startsWith(p) || norm + "/" === p)) {
				return true;
			}
		}
		return false;
	}

	private isOnDefaultBranch(project: ProjectMin, dto: GitEventDto): boolean {
		const def = project.git_default_branch ?? "main";
		return (
			dto.branch === def ||
			dto.branch === `origin/${def}` ||
			dto.branch === `refs/heads/${def}`
		);
	}

	private findTaskByScope(project: ProjectMin, scope: string): string | null {
		const target = normaliseScope(scope);
		if (!target) return null;
		for (const [key, taskId] of Object.entries(project.task_index)) {
			if (key === "overview" || key === "history") continue;
			if (key.startsWith("commit:")) continue; // never close prior commit tasks
			if (normaliseScope(key).includes(target)) return taskId;
		}
		return null;
	}

	private todoDescription(
		diff: { file: string; line?: number; marker: string; text: string },
		sha: string,
	): string {
		return [
			`**File:** \`${diff.file}${diff.line ? `:${diff.line}` : ""}\``,
			`**Marker:** \`${diff.marker}\``,
			`**Introduced in:** ${sha.slice(0, 8)}`,
			"",
			"```",
			diff.text,
			"```",
			"",
			"_Created by clickup-tracker from a post-commit diff._",
		].join("\n");
	}
}

function truncate(s: string, n: number): string {
	if (!s) return s;
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function mapFileStatus(status: string | undefined): CommitFileChange["status"] {
	switch (status) {
		case "added":
			return "A";
		case "modified":
			return "M";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		default:
			return "M";
	}
}

function mapCcTypeToBgmt(cc: string | null): CommitRecord["type"] | null {
	if (!cc) return null;
	switch (cc.toLowerCase()) {
		case "feat":
			return "Feature";
		case "fix":
			return "Bug Fix";
		case "docs":
			return "Docs";
		case "refactor":
		case "restructure":
			return "Refactor";
		case "chore":
			return "Chore";
		case "style":
			return "Style";
		case "perf":
			return "Performance";
		case "test":
			return "Test";
		case "build":
			return "Build";
		case "ci":
			return "CI/CD";
		case "revert":
			return "Revert";
		default:
			return null;
	}
}

function stripSprintPrefix(key: string): string {
	return key.startsWith("sprint:") ? key.slice("sprint:".length) : key;
}

const KEBAB_RX = /[^a-z0-9]+/g;
function kebab(s: string): string {
	return s
		.toLowerCase()
		.replace(KEBAB_RX, "-")
		.replace(/(^-|-$)/g, "");
}

// keep unused import warning quiet — sprintListKey is exported for callers
// that want symmetric key construction.
void sprintListKey;
void normalizeAuthor;
