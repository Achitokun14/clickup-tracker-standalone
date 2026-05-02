import { HttpException, Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CustomFieldsService } from "../clickup/custom-fields";
import { CredentialsService } from "../credentials/credentials.service";
import { eventsTotal } from "../metrics/registry";
import { PrismaService } from "../prisma/prisma.service";
import { GithubIdentityService } from "../projects/github-identity.service";
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
import { classifyArtifact, normalizeAuthor } from "../util/classify";
import { parseCoAuthors } from "../util/co-author-parse";
import { extractIssueRefs } from "../util/issue-refs";
import {
	normaliseScope,
	parseConventional,
	parseScopeRename,
} from "./conventional";
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
	| { kind: "conflict_skipped"; task_id: string }
	| { kind: "doc_append"; page_id: string };

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
	custom_field_ids: Record<string, Record<string, string>>;
	scope_config: { mode?: string; paths?: string[] };
	git_default_branch: string | null;
	git_remote_url: string | null;
	git_remote_host: string | null;
	git_remote_owner_repo: string | null;
	template_status: string | null;
	clickup_doc_id: string | null;
	status: string;
}

@Injectable()
export class EventsService {
	private readonly log = new Logger(EventsService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly sync: SyncService,
		private readonly customFields: CustomFieldsService,
		private readonly githubIdentity: GithubIdentityService,
	) {}

	// ── git events ─────────────────────────────────────────────

	/**
	 * Resolve the branch for an incoming git-event payload. The post-commit
	 * hook *should* always send a branch, but stale hooks (installed before
	 * the branch-default fix) can send empty strings. When that happens we
	 * synth from project.git_default_branch so the planner doesn't misroute
	 * the commit to In Review (Plan §A.1, Bug 1, layer 2 of 3).
	 */
	private resolveBranch(
		dto: { branch?: string | null },
		project: { id: string; git_default_branch: string | null },
	): string {
		const trimmed = (dto.branch ?? "").trim();
		if (trimmed) return trimmed;
		const fallback = project.git_default_branch ?? "main";
		this.log.warn(
			`git-event for project ${project.id} arrived without branch; ` +
				`synthesising '${fallback}' (stale hook?)`,
		);
		return fallback;
	}

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

		// Plan §C.3 — branch-deletion event: not a commit; close any
		// open In Review tasks for that branch and short-circuit.
		if (dto.branch_deleted) {
			const closed = await this.tryHandleBranchDeleted(project, dto);
			eventsTotal.inc({ kind: "git", outcome: "branch_deleted" });
			return {
				eventId: "",
				replayed: false,
				actionsCount: closed.length,
				actions: closed,
			};
		}

		// Plan §B.6/§B.8 — short-circuit when the project is in a halt
		// state. We still want to ack the event so the hook doesn't retry
		// forever; we just skip CU writes. The git_events row insert
		// below is intentionally skipped too (the next attempt after
		// recovery will see the missing SHA and the user can replay).
		if (project.status !== "active") {
			eventsTotal.inc({ kind: "git", outcome: project.status });
			return {
				eventId: "",
				replayed: false,
				actionsCount: 1,
				actions: [{ kind: "skipped", reason: `status:${project.status}` }],
			};
		}

		// 3. Persist git_events row (always — even if scope filter rejects).
		//    `clickup_team_id` is set so the team-level partial UNIQUE index
		//    (Plan §B.4) can dedupe the same SHA across two developers'
		//    project rows. The legacy (project_id, commit_sha) UNIQUE still
		//    fires on same-project replay; we keep ON CONFLICT pointed at it
		//    so DO UPDATE behaviour is preserved. Cross-project, same-team
		//    duplicates surface as a unique-violation we catch below.
		const branch = this.resolveBranch(dto, project);
		let eventId: string;
		try {
			const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
				`INSERT INTO clickup_tracker.git_events (
          project_id, clickup_team_id, commit_sha, branch, author, committer_email,
          committed_at, message, files_changed, todo_diffs, resulting_actions
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9::jsonb, $10::jsonb, '[]'::jsonb)
        ON CONFLICT (project_id, commit_sha) DO UPDATE SET message = EXCLUDED.message
        RETURNING id`,
				project.id,
				project.clickup_team_id ?? null,
				dto.commit_sha,
				branch,
				dto.author ?? null,
				dto.committer_email ?? null,
				dto.committed_at ?? null,
				dto.message,
				JSON.stringify(dto.files_changed ?? []),
				JSON.stringify(dto.todo_diffs ?? []),
			);
			eventId = inserted[0].id;
		} catch (err) {
			// Team-level UNIQUE collision: another developer's daemon already
			// recorded this commit. Look up the canonical row, return its id,
			// and skip downstream ClickUp emission (the first daemon owns the
			// task; this one just attributes the local event).
			const msg = (err as Error).message ?? "";
			if (msg.includes("git_events_team_sha_uniq") && project.clickup_team_id) {
				const existing = await this.prisma.$queryRawUnsafe<
					Array<{ id: string }>
				>(
					`SELECT id FROM clickup_tracker.git_events
           WHERE clickup_team_id = $1 AND commit_sha = $2
           LIMIT 1`,
					project.clickup_team_id,
					dto.commit_sha,
				);
				if (!existing[0]) throw err;
				this.log.log(
					`git-event sha=${dto.commit_sha.slice(0, 8)} already recorded by ` +
						`peer daemon in team ${project.clickup_team_id}; skipping CU emit`,
				);
				return {
					eventId: existing[0].id,
					replayed: true,
					actionsCount: 0,
					actions: [{ kind: "skipped", reason: "peer_daemon_owns" }],
				};
			}
			throw err;
		}

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

		// 7+8. TODO diffs + commit task. Both call CU writes; on a 401
		// we flip the project to `auth-needed` (Plan §B.6) so subsequent
		// crons stop trying. We do NOT swallow the throw — the queue
		// retries the job, and the next attempt will see status changed
		// (callers + crons filter on status='active').
		try {
			// 7. TODO diffs first — orthogonal to commit-task creation.
			await this.handleTodoDiffs(
				project,
				dto,
				source ?? "human",
				actions,
				creds,
			);

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
		} catch (err) {
			if (this.isAuth401(err)) {
				await this.flipProjectToAuthNeeded(
					project.id,
					`401 from CU during commit ${dto.commit_sha.slice(0, 8)} ingest`,
				);
				actions.push({ kind: "skipped", reason: "auth_needed" });
				await this.persistActions(eventId, actions);
				return {
					eventId,
					replayed: false,
					actionsCount: actions.length,
					actions,
				};
			}
			throw err;
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
		const branch = this.resolveBranch(dto, project);
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
			refs: [branch, `origin/${branch}`],
			branch,
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
		let createdTaskId: string | null = null;
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
			createdTaskId = created.id;
			await this.appendToTaskIndex(project.id, { [planned.key]: created.id });
			project.task_index[planned.key] = created.id;
			actions.push({
				kind: "create_task",
				task_id: created.id,
				list_key: resolvedKey,
				source: `git:${dto.commit_sha}`,
			});
		} catch (err) {
			// Plan §B.6 — let auth failures propagate so the outer catch
			// can flip the project to `auth-needed`.
			if (this.isAuth401(err)) throw err;
			this.log.warn(`createTask (commit) failed: ${(err as Error).message}`);
			actions.push({ kind: "skipped", reason: "create_task_failed" });
			return;
		}

		// 4b. Plan §C.5 — artifact classification side-effects. For each file
		// changed, dispatch on its kind (adr/doc/infra/dependency/...). A
		// single bundled comment on the new commit task lists everything
		// non-code that this commit touched, so non-code changes (deps,
		// infra, docs) get visible attention without a separate task per
		// file. `generated` is suppressed; `code` produces no comment.
		if (createdTaskId) {
			await this.tryAppendArtifactWatch(
				createdTaskId,
				dto.files_changed ?? [],
				creds.token,
				actions,
			);
		}

		// 4d. Plan §E.5 — auto-add commit author as a watcher on the new task
		// so they get CU notifications for status changes / comments. Best-
		// effort; missing member or 4xx is non-fatal.
		if (createdTaskId && dto.committer_email && project.clickup_team_id) {
			await this.tryAddAuthorAsWatcher(
				createdTaskId,
				dto.committer_email,
				project.clickup_team_id,
				creds.token,
			);
		}

		// 4e. Plan §F.3 — write structured author fields on the commit task:
		//   - commit_sha
		//   - author_email
		//   - author_github_url (resolved via GitHub commits API; cached)
		//   - source = "commit"
		// All best-effort; per-field failures debug-logged inside helpers.
		if (createdTaskId) {
			await this.tryWriteAuthorFields(
				project,
				createdTaskId,
				resolvedKey,
				dto.commit_sha,
				dto.committer_email ?? null,
				creds.token,
			);
		}

		// 4g. Plan §K.6 — auto-link issue refs in the commit body to existing
		// CU tasks (via task_index['issue:NN']) or attach the external URL.
		if (createdTaskId) {
			await this.tryLinkIssueRefs(project, createdTaskId, cc.body, creds.token);
		}

		// 4f. Plan §I.3 — record pair-programming partners. `Co-authored-by`
		// trailers in the commit body get written to commit_authors with
		// role=co-author (primary author from the DTO is also recorded).
		// Each resolvable co-author is added as a CU watcher on the new
		// task so they get notification parity with the primary author.
		if (createdTaskId) {
			await this.tryRecordCommitAuthors(
				project,
				createdTaskId,
				dto,
				cc.body,
				creds,
			);
		}

		// 4c. Plan §C.3 — file rename annotations + file delete close.
		await this.tryHandleFileRenames(
			project,
			dto,
			actions,
			creds.token,
			createdTaskId,
		);
		await this.tryHandleFileDeletions(project, dto, actions, creds.token);

		// 5. Conventional-verb side-effects.
		// Plan §C.3 — when the scope itself encodes a rename
		// (e.g. `refactor(legacy→v2):`), surface the cross-link before
		// fix/feat handlers; we never close on a rename, only annotate.
		const rename = parseScopeRename(cc.scope);
		if (rename) {
			await this.tryHandleScopeRename(
				project,
				rename.from,
				rename.to,
				dto.commit_sha,
				cc.subject,
				actions,
				creds.token,
				createdTaskId,
			);
		} else if (cc.type === "fix" && cc.scope) {
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

		// 5b. Append a one-paragraph summary to the Doc's Changelog page for
		// default-branch commits. Best-effort, non-blocking — page lookup is
		// memoised on project.task_index['doc_page:Changelog'].
		if (this.isOnDefaultBranch(project, dto)) {
			await this.tryAppendChangelogPage(
				project,
				creds.token,
				creds.team_id,
				planned.name,
				dto.commit_sha,
				cc.subject,
				dto.committer_email ?? null,
				actions,
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

	/**
	 * Plan §C.3 — handle `refactor(old→new):` scope renames. We never
	 * close tasks on a rename (the work isn't done — it's relocated);
	 * we cross-link old + new scope tasks and tag both for discovery.
	 *
	 * Best-effort:
	 *   - tag both tasks `scope-renamed` (CU dedupes tag adds)
	 *   - comment on each linking to the other + this commit
	 *   - if the new scope has no task yet, just comment on the old one
	 *     and tag the commit task itself for traceability
	 */
	private async tryHandleScopeRename(
		project: ProjectMin,
		fromScope: string,
		toScope: string,
		sha: string,
		subject: string,
		actions: ResultingAction[],
		token: string,
		commitTaskId: string | null,
	): Promise<void> {
		const oldId = this.findTaskByScope(project, fromScope);
		const newId = this.findTaskByScope(project, toScope);
		const shaShort = sha.slice(0, 8);

		const stamp = (where: "old" | "new", peerId: string | null): string => {
			const peer = peerId
				? `Linked task: ${peerId}`
				: "_(no task tracked under that scope yet)_";
			const direction =
				where === "old"
					? `${fromScope} → ${toScope}`
					: `${toScope} ← ${fromScope}`;
			return [
				`**Scope renamed:** \`${direction}\``,
				`**Commit:** \`${shaShort}\` — ${subject}`,
				peer,
			].join("\n");
		};

		const tagPair: Array<[string, string]> = [];
		if (oldId) tagPair.push([oldId, "scope-renamed"]);
		if (newId) tagPair.push([newId, "scope-renamed"]);

		for (const [taskId, tag] of tagPair) {
			try {
				await this.clickup.addTagToTask(taskId, tag, token);
			} catch (err) {
				this.log.debug(
					`addTagToTask(${tag}) on ${taskId} failed: ${(err as Error).message}`,
				);
			}
		}

		if (oldId) {
			try {
				await this.clickup.addComment(oldId, stamp("old", newId), token);
				actions.push({ kind: "comment", task_id: oldId } as ResultingAction);
			} catch {
				/* swallow */
			}
		}
		if (newId && newId !== oldId) {
			try {
				await this.clickup.addComment(newId, stamp("new", oldId), token);
				actions.push({ kind: "comment", task_id: newId } as ResultingAction);
			} catch {
				/* swallow */
			}
		}

		// If neither side has a tracked task yet, leave a breadcrumb on the
		// commit task itself so the rename isn't lost.
		if (!oldId && !newId && commitTaskId) {
			try {
				await this.clickup.addComment(
					commitTaskId,
					`**Scope renamed:** \`${fromScope} → ${toScope}\` _(no tracked tasks under either scope yet)_`,
					token,
				);
				actions.push({
					kind: "comment",
					task_id: commitTaskId,
				} as ResultingAction);
			} catch {
				/* swallow */
			}
		}
	}

	/**
	 * Plan §C.3 — branch-delete signal. Walk task_index for any
	 * `commit:<sha>` whose stored git_events.branch matches this dto's
	 * branch + is currently in In Review; setStatus('Closed') + tag
	 * `branch-deleted`. Best-effort: failures per-task are logged and
	 * skipped, the overall ack still succeeds.
	 *
	 * No CU listSpaces/listTasksInList needed — we use the local
	 * task_index for membership and an SQL lookup against git_events
	 * to filter by branch.
	 */
	private async tryHandleBranchDeleted(
		project: ProjectMin,
		dto: GitEventDto,
	): Promise<ResultingAction[]> {
		const actions: ResultingAction[] = [];
		const branch = (dto.branch ?? "").trim();
		if (!branch) {
			actions.push({
				kind: "skipped",
				reason: "branch_deleted_no_branch",
			});
			return actions;
		}

		// Look up commit SHAs we recorded for this branch on this project.
		let shas: string[] = [];
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{ commit_sha: string }>
			>(
				`SELECT commit_sha FROM clickup_tracker.git_events
         WHERE project_id = $1::uuid
           AND branch = $2
         ORDER BY created_at DESC
         LIMIT 200`,
				project.id,
				branch,
			);
			shas = rows.map((r) => r.commit_sha);
		} catch (err) {
			this.log.debug(
				`branch-deleted: lookup failed for ${branch}: ${(err as Error).message}`,
			);
			actions.push({
				kind: "skipped",
				reason: "branch_deleted_lookup_failed",
			});
			return actions;
		}

		let credsToken: string;
		try {
			const c = await this.credentials.forOrg(project.organisation_id);
			credsToken = c.token;
		} catch {
			actions.push({
				kind: "skipped",
				reason: "branch_deleted_no_credentials",
			});
			return actions;
		}

		let closedCount = 0;
		for (const sha of shas) {
			const taskId = project.task_index[`commit:${sha}`];
			if (!taskId) continue;
			try {
				await this.clickup.setTaskStatus(taskId, "Closed", credsToken);
				closedCount += 1;
				actions.push({
					kind: "close_task",
					task_id: taskId,
					reason: "branch_deleted",
				} as ResultingAction);
			} catch (err) {
				if (this.isAuth401(err)) {
					await this.flipProjectToAuthNeeded(
						project.id,
						`401 from CU during branch-delete close on ${branch}`,
					);
					actions.push({ kind: "skipped", reason: "auth_needed" });
					return actions;
				}
				this.log.debug(
					`branch-deleted: setTaskStatus(${taskId}) failed: ${(err as Error).message}`,
				);
			}
		}
		this.log.log(
			`branch-deleted ${branch} on project ${project.id}: closed ${closedCount}/${shas.length} commit task(s)`,
		);
		if (closedCount === 0) {
			actions.push({
				kind: "skipped",
				reason: "branch_deleted_no_tasks",
			});
		}
		return actions;
	}

	/**
	 * Plan §C.3 — for any file in `files_changed` with status='renamed'
	 * and `prev_path` set, append a comment on the commit task noting
	 * the rename. Forward-compatible: older hooks don't emit prev_path
	 * so this is a no-op for them.
	 */
	private async tryHandleFileRenames(
		project: ProjectMin,
		dto: GitEventDto,
		actions: ResultingAction[],
		token: string,
		commitTaskId: string | null,
	): Promise<void> {
		if (!commitTaskId) return;
		const renames = (dto.files_changed ?? []).filter(
			(f) => f.status === "renamed" && (f as any).prev_path,
		);
		if (renames.length === 0) return;
		const lines = renames
			.slice(0, 10)
			.map((f) => `- \`${(f as any).prev_path}\` → \`${f.path}\``);
		if (renames.length > 10) {
			lines.push(`- _… +${renames.length - 10} more renames_`);
		}
		try {
			await this.clickup.addComment(
				commitTaskId,
				`**Renames:**\n${lines.join("\n")}`,
				token,
			);
			actions.push({
				kind: "comment",
				task_id: commitTaskId,
				reason: "file_rename",
			} as ResultingAction);
			void project; // unused; kept for parity with sibling handlers
		} catch (err) {
			if (this.isAuth401(err)) throw err;
			this.log.debug(
				`tryHandleFileRenames: addComment failed: ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §C.3 — for any file in `files_changed` with status='deleted',
	 * close any Open Work tasks anchored to that path. Anchor detection:
	 * task_index keys of the form `path:<file>` (a forward-compat key
	 * the planner can populate). When no such key exists for the file,
	 * the deletion is a no-op (the artifact-watch comment already
	 * surfaces the change).
	 */
	private async tryHandleFileDeletions(
		project: ProjectMin,
		dto: GitEventDto,
		actions: ResultingAction[],
		token: string,
	): Promise<void> {
		const deletions = (dto.files_changed ?? []).filter(
			(f) => f.status === "deleted",
		);
		if (deletions.length === 0) return;
		for (const f of deletions) {
			const key = `path:${f.path}`;
			const taskId = project.task_index[key];
			if (!taskId) continue;
			try {
				await this.clickup.setTaskStatus(taskId, "Closed", token);
				try {
					await this.clickup.addComment(
						taskId,
						`Closed automatically: anchor file \`${f.path}\` deleted in commit \`${dto.commit_sha.slice(0, 8)}\`.`,
						token,
					);
				} catch {
					/* swallow: the close itself succeeded */
				}
				actions.push({
					kind: "close_task",
					task_id: taskId,
					reason: "file_deleted",
				} as ResultingAction);
			} catch (err) {
				if (this.isAuth401(err)) throw err;
				this.log.debug(
					`tryHandleFileDeletions: setTaskStatus(${taskId}) failed: ${(err as Error).message}`,
				);
			}
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

	/**
	 * Append a paragraph to the Space Doc's Changelog page on every commit
	 * landing on the default branch. Best-effort and non-blocking —
	 * lookup of the Changelog page id is memoised in task_index under
	 * 'doc_page:Changelog' so we only listDocPages once per project.
	 */
	/**
	 * Plan §C.5 — bundle a single "Artifact watch" comment on the commit
	 * task summarising every non-code, non-generated file the commit
	 * touched. One CU API call regardless of file count. Skipped entirely
	 * when the commit only touched code files (the common case).
	 */
	/**
	 * Plan §F.3 — populate the structured author/commit custom fields on
	 * the freshly-created commit task. Resolves the GitHub identity
	 * (cached / on-demand fetch) so a profile URL can be written. Skips
	 * silently when the project pre-dates field seeding (custom_field_ids
	 * for the list is empty).
	 */
	private async tryWriteAuthorFields(
		project: ProjectMin,
		taskId: string,
		listKey: string,
		commitSha: string,
		authorEmail: string | null,
		token: string,
	): Promise<void> {
		const fieldIds = project.custom_field_ids?.[listKey];
		if (!fieldIds || Object.keys(fieldIds).length === 0) return;

		let githubUrl: string | null = null;
		if (authorEmail && project.git_remote_owner_repo) {
			try {
				const id = await this.githubIdentity.resolve(authorEmail, {
					commitSha,
					ownerRepo: project.git_remote_owner_repo,
					host: project.git_remote_host,
				});
				githubUrl = id?.github_url ?? null;
			} catch (err) {
				this.log.debug(
					`githubIdentity.resolve(${authorEmail}) failed: ${(err as Error).message}`,
				);
			}
		}

		await this.customFields.setFieldsOnTask(
			taskId,
			fieldIds,
			{
				commit_sha: commitSha,
				author_email: authorEmail ?? undefined,
				author_github_url: githubUrl ?? undefined,
				source: "commit",
			},
			token,
		);
	}

	/**
	 * Plan §E.5 — resolve commit author email against members_cache and
	 * call addWatcher on the newly-created task. Single fetch per
	 * commit; on miss (external contributor not yet in the workspace) we
	 * just log at debug. Email comparison is case-insensitive to match
	 * how members_cache stores keys.
	 */
	private async tryAddAuthorAsWatcher(
		taskId: string,
		authorEmail: string,
		teamId: string,
		token: string,
	): Promise<void> {
		try {
			const cache = await this.loadMembersCache(teamId);
			const lower = authorEmail.toLowerCase();
			const userId =
				cache[lower] ??
				cache[authorEmail] ??
				Object.entries(cache).find(([k]) => k.toLowerCase() === lower)?.[1];
			if (!userId) {
				this.log.debug(
					`watcher skip: ${authorEmail} not in members_cache for team ${teamId}`,
				);
				return;
			}
			await this.clickup.addWatcher(taskId, userId, token);
		} catch (err) {
			this.log.debug(
				`tryAddAuthorAsWatcher(${taskId}, ${authorEmail}) failed: ` +
					`${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §I.3 — write commit_authors rows (primary + co-authors) and add
	 * each resolvable co-author as a CU watcher on the new commit task.
	 * Trailers are parsed from the commit body (`Co-authored-by: Name <email>`).
	 * Idempotent via the (project_id, commit_sha, email) PK.
	 */
	private async tryRecordCommitAuthors(
		project: ProjectMin,
		taskId: string,
		dto: GitEventDto,
		body: string | null | undefined,
		creds: { token: string; team_id: string },
	): Promise<void> {
		const primary = (dto.committer_email ?? "").toLowerCase().trim();
		const coAuthors = parseCoAuthors(body ?? null).filter(
			(a) => a.email !== primary,
		);
		// Always upsert primary; only insert co-authors when present. If we
		// have neither (e.g. anonymous commit), short-circuit.
		if (!primary && coAuthors.length === 0) return;
		try {
			if (primary) {
				await this.prisma.$executeRawUnsafe(
					`INSERT INTO clickup_tracker.commit_authors
					   (project_id, commit_sha, email, role)
					 VALUES ($1::uuid, $2, $3, 'primary')
					 ON CONFLICT (project_id, commit_sha, email) DO NOTHING`,
					project.id,
					dto.commit_sha,
					primary,
				);
			}
			for (const ca of coAuthors) {
				await this.prisma.$executeRawUnsafe(
					`INSERT INTO clickup_tracker.commit_authors
					   (project_id, commit_sha, email, role)
					 VALUES ($1::uuid, $2, $3, 'co-author')
					 ON CONFLICT (project_id, commit_sha, email) DO NOTHING`,
					project.id,
					dto.commit_sha,
					ca.email,
				);
			}
		} catch (err) {
			this.log.debug(
				`tryRecordCommitAuthors write failed: ${(err as Error).message}`,
			);
		}
		// Add resolvable co-authors as watchers (best-effort). Primary is
		// already added in step 4d.
		for (const ca of coAuthors) {
			await this.tryAddAuthorAsWatcher(
				taskId,
				ca.email,
				creds.team_id,
				creds.token,
			);
		}
	}

	/**
	 * Plan §K.6 — extract issue refs from a commit body and attach them
	 * to the new commit task. Local refs (`#NN`, `GH-NN`, `BUG-7`) try
	 * task_index['issue:NN'] / ['issue:KEY'] for an internal CU link;
	 * cross-repo refs (`owner/repo#NN`) become external URL attachments.
	 * All best-effort; per-ref failures debug-logged.
	 */
	private async tryLinkIssueRefs(
		project: ProjectMin,
		taskId: string,
		body: string | null | undefined,
		token: string,
	): Promise<void> {
		const refs = extractIssueRefs(body);
		if (refs.length === 0) return;
		for (const ref of refs) {
			try {
				if (ref.kind === "gh-cross-repo" && ref.ownerRepo && ref.number) {
					const url = `https://github.com/${ref.ownerRepo}/issues/${ref.number}`;
					await this.clickup.addTaskUrlAttachment(
						taskId,
						{ url, name: ref.raw },
						token,
					);
					continue;
				}
				const indexKey =
					ref.kind === "jira-like" && ref.key
						? `issue:${ref.key}`
						: ref.number
							? `issue:${ref.number}`
							: null;
				if (!indexKey) continue;
				const linkedTaskId = project.task_index?.[indexKey];
				if (linkedTaskId) {
					await this.clickup.addTaskLink(taskId, linkedTaskId, token);
				}
				// No internal task → silently skip; cross-repo path is the only
				// one we attach an external URL for, since plain `#7` could be
				// any tracker.
			} catch (err) {
				this.log.debug(
					`tryLinkIssueRefs ${ref.raw} failed: ${(err as Error).message}`,
				);
			}
		}
	}

	private async loadMembersCache(
		teamId: string,
	): Promise<Record<string, number>> {
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{ members_cache: Record<string, number> | null }>
		>(
			`SELECT members_cache FROM clickup_tracker.workspace_settings
			 WHERE clickup_team_id = $1::text LIMIT 1`,
			teamId,
		);
		return rows[0]?.members_cache ?? {};
	}

	private async tryAppendArtifactWatch(
		taskId: string,
		files: Array<{ path: string; status?: string }>,
		token: string,
		actions: ResultingAction[],
	): Promise<void> {
		if (files.length === 0) return;
		const grouped = new Map<string, string[]>();
		for (const f of files) {
			const kind = classifyArtifact(f.path);
			if (kind === "code" || kind === "generated") continue;
			const arr = grouped.get(kind) ?? [];
			arr.push(f.path);
			grouped.set(kind, arr);
		}
		if (grouped.size === 0) return;
		// Plan §H.3 — render as a Markdown table so the comment is scannable
		// in the CU UI instead of a flat bullet list.
		const lines: string[] = ["**Artifact watch:**", ""];
		lines.push("| Kind | Count | Files |");
		lines.push("|---|---|---|");
		for (const [kind, paths] of grouped) {
			const sample = paths
				.slice(0, 5)
				.map((p) => `\`${p}\``)
				.join(", ");
			const more = paths.length > 5 ? ` …+${paths.length - 5}` : "";
			lines.push(`| ${kind} | ${paths.length} | ${sample}${more} |`);
		}
		try {
			await this.clickup.addComment(taskId, lines.join("\n"), token);
			actions.push({ kind: "comment", task_id: taskId });
		} catch (err) {
			this.log.warn(`artifact-watch comment failed: ${(err as Error).message}`);
		}
	}

	private async tryAppendChangelogPage(
		project: ProjectMin,
		token: string,
		teamId: string,
		taskName: string,
		commitSha: string,
		subject: string,
		authorEmail: string | null,
		actions: ResultingAction[],
	): Promise<void> {
		const docId = project.clickup_doc_id;
		if (!docId) return;
		try {
			let pageId = project.task_index["doc_page:Changelog"];
			if (!pageId) {
				const pages = await this.clickup.listDocPages(teamId, docId, token);
				const found = pages.find((p) => p.name === "Changelog");
				if (!found) return;
				pageId = found.id;
				await this.appendToTaskIndex(project.id, {
					"doc_page:Changelog": pageId,
				});
				project.task_index["doc_page:Changelog"] = pageId;
			}
			// Plan §H.4 — attribution-aware Changelog. Prefer the cached GitHub
			// identity for an avatar + login link; fall back to plain email.
			const identity = authorEmail
				? await this.loadIdentityForChangelog(authorEmail)
				: null;
			const author = identity?.github_login
				? `${identity.avatar_url ? `![](${identity.avatar_url}) ` : ""}[${identity.github_login}](${identity.github_url ?? ""})`
				: (authorEmail ?? "_(unknown)_");
			const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
			const para =
				`\n\n- \`${stamp} UTC\` · **${commitSha.slice(0, 8)}** by ${author} — ${taskName}` +
				(subject && subject !== taskName ? `  \n  ${subject}` : "");
			await this.clickup.updateDocPage(
				teamId,
				docId,
				pageId,
				{ content: para, content_edit_mode: "append" },
				token,
			);
			actions.push({ kind: "doc_append", page_id: pageId });
		} catch (err) {
			this.log.debug(`changelog page append failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Plan §H.4 — best-effort lookup of cached GitHub identity for a given
	 * email so the Changelog line can render an avatar + login link instead
	 * of raw email. Reads cache only — never triggers a GitHub API call.
	 */
	private async loadIdentityForChangelog(email: string): Promise<{
		github_login: string | null;
		github_url: string | null;
		avatar_url: string | null;
	} | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					github_login: string | null;
					github_url: string | null;
					avatar_url: string | null;
				}>
			>(
				`SELECT github_login, github_url, avatar_url
				 FROM clickup_tracker.github_identities
				 WHERE email = $1::text
				 LIMIT 1`,
				email.toLowerCase(),
			);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}

	// ── helpers ─────────────────────────────────────────────────

	/**
	 * Plan §B.6 — detect a 401 from CU. ClickUpDirectService throws
	 * HttpException(401) on auth failures (and a wrapped Error string
	 * containing "401" for legacy paths). Match both shapes defensively.
	 */
	private isAuth401(err: unknown): boolean {
		if (err instanceof HttpException && err.getStatus() === 401) return true;
		const msg = err instanceof Error ? err.message : String(err);
		return /\b(?:HTTP\s+)?401\b/.test(msg) || /unauthor[i|y]z/i.test(msg);
	}

	/**
	 * Plan §B.6 — flip the project to `auth-needed` so daemon writes
	 * stop until the operator rotates credentials. Inlined SQL (avoids
	 * a circular import on ProjectsService).
	 */
	private async flipProjectToAuthNeeded(
		projectId: string,
		reason: string,
	): Promise<void> {
		try {
			const r = await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET status = 'auth-needed', updated_at = NOW()
         WHERE id = $1::uuid AND status = 'active'`,
				projectId,
			);
			if (r > 0) {
				this.log.warn(`flipped project ${projectId} → auth-needed (${reason})`);
			}
		} catch (err) {
			this.log.warn(
				`flipProjectToAuthNeeded(${projectId}) failed: ${(err as Error).message}`,
			);
		}
	}

	private async loadProject(projectId: string): Promise<ProjectMin | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
			`SELECT id, organisation_id, display_name, clickup_team_id,
              clickup_space_id, clickup_folder_id,
              list_ids::jsonb AS list_ids,
              COALESCE(sprint_lists, '{}'::jsonb)::jsonb AS sprint_lists,
              task_index::jsonb AS task_index,
              COALESCE(custom_field_ids, '{}'::jsonb)::jsonb AS custom_field_ids,
              scope_config::jsonb AS scope_config,
              git_default_branch, git_remote_url,
              git_remote_host, git_remote_owner_repo,
              template_status, clickup_doc_id,
              status
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
