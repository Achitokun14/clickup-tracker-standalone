import {
	Injectable,
	NotFoundException,
	BadRequestException,
	Logger,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CredentialsService } from "../credentials/credentials.service";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { BackupService } from "../backup/backup.service";
import { LIST_NAMES, planRepo } from "../bulk/hierarchy";
import type { RepoEntry, RepoExtract, ListKey, RepoPlan } from "../bulk/types";
import { QueueService } from "../queue/queue.service";
import type {
	RegisterProjectDto,
	PatchProjectDto,
} from "./dto/register-project.dto";

const DEFAULT_SPACE_NAME = process.env.DEFAULT_CLICKUP_SPACE_NAME || "Default";

export interface ProjectRow {
	id: string;
	organisation_id: string;
	local_path: string;
	display_name: string;
	git_remote_url: string | null;
	scope_config: { mode: string; paths?: string[] };
	clickup_team_id: string;
	clickup_space_id: string;
	clickup_folder_id: string;
	list_ids: Record<ListKey, string>;
	custom_field_ids: Record<string, string>;
	task_index: Record<string, string>;
	hook_secret: string;
	status: string;
	last_synced_at: Date | null;
	created_at: Date;
	updated_at: Date;
	// Per-repo Space columns (schema/02_per_repo_space.sql).
	clickup_doc_id: string | null;
	sprint_lists: Record<string, string>;
	backfill_state: Record<string, unknown> | null;
	template_status: string | null;
	git_default_branch: string | null;
	git_remote_host: string | null;
	git_remote_owner_repo: string | null;
	last_seen_status_changes: unknown[];
	// Plan §M.1 / §N.2 — webhook + Railway bindings (schema 05).
	github_webhook_id: string | null;
	github_webhook_secret: string | null;
	railway_project_id: string | null;
	railway_service_ids: string[];
	railway_environments: Record<string, string>;
	last_railway_poll_at: Date | null;
	deployments_list_id: string | null;
	whiteboard_url: string | null;
	bug_form_url: string | null;
}

export interface ProjectSummary {
	id: string;
	localPath: string;
	displayName: string;
	status: string;
	folderUrl: string;
	taskCount: number;
	lastSyncedAt: string | null;
}

export interface RegisterResult {
	projectId: string;
	folderId: string;
	folderUrl: string;
	spaceId: string;
	listIds: Record<ListKey, string>;
	hookSecret: string; // returned ONCE
	taskCount: number;
	alreadyTracked: boolean;
	scopeConfig?: { mode: string; paths?: string[] } | null;
}

@Injectable()
export class ProjectsService {
	private readonly log = new Logger(ProjectsService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly backups: BackupService,
		private readonly queue: QueueService,
	) {}

	/**
	 * Longest-prefix match on local_path. Used by Claude Code hooks to figure
	 * out which tracked project a CWD belongs to. Returns null if no project
	 * is an ancestor of the given path.
	 */
	async resolveByPath(
		orgId: string,
		cwd: string,
	): Promise<{ id: string; localPath: string; displayName: string } | null> {
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{ id: string; local_path: string; display_name: string }>
		>(
			`SELECT id, local_path, display_name
       FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid AND status = 'active'`,
			orgId,
		);

		let best: { id: string; local_path: string; display_name: string } | null =
			null;
		for (const row of rows) {
			const lp = row.local_path.replace(/\/+$/, "");
			if (cwd === lp || cwd.startsWith(lp + "/")) {
				if (!best || row.local_path.length > best.local_path.length) best = row;
			}
		}
		if (!best) return null;
		return {
			id: best.id,
			localPath: best.local_path,
			displayName: best.display_name,
		};
	}

	async list(orgId: string): Promise<ProjectSummary[]> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`SELECT * FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid
       ORDER BY updated_at DESC`,
			orgId,
		);
		return rows.map((r) => this.toSummary(r));
	}

	async get(orgId: string, projectId: string): Promise<ProjectRow> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`SELECT * FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid AND id = $2::uuid`,
			orgId,
			projectId,
		);
		if (rows.length === 0) throw new NotFoundException("project not found");
		return rows[0];
	}

	async register(
		orgId: string,
		dto: RegisterProjectDto,
	): Promise<RegisterResult> {
		if (!dto.localPath) throw new BadRequestException("localPath required");

		// Idempotency: same (org, localPath) OR (org, git_remote_url) and still
		// active/paused — return existing. Plan §B.7 worktree dedupe: a user
		// who clones the same repo to a second path (worktree, mirror, fresh
		// clone) gets routed back to the original project row instead of
		// creating a duplicate Space. `removed` rows are ignored here so
		// users can re-register a path they previously untracked. The stale
		// row is cleared before INSERT below. Prefers the exact local_path
		// match when both could apply.
		const existing = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`SELECT * FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid
         AND status <> 'removed'
         AND (local_path = $2
              OR ($3::text IS NOT NULL
                  AND $3::text <> ''
                  AND git_remote_url = $3::text))
       ORDER BY (local_path = $2) DESC NULLS LAST
       LIMIT 1`,
			orgId,
			dto.localPath,
			dto.gitRemoteUrl ?? null,
		);
		if (existing.length > 0) {
			const row = existing[0];
			return {
				projectId: row.id,
				folderId: row.clickup_folder_id,
				folderUrl: this.folderUrl(row.clickup_team_id, row.clickup_folder_id),
				spaceId: row.clickup_space_id,
				listIds: row.list_ids,
				hookSecret: "", // never re-issued
				taskCount: Object.keys(row.task_index).length,
				alreadyTracked: true,
			};
		}

		// New per-repo Space mode: insert empty row, enqueue backfill, return.
		// The orchestrator (BackfillService) walks planSpace() asynchronously.
		if (dto.backfillMode === "space" && !dto.dryRun) {
			return this.registerSpaceMode(orgId, dto);
		}

		if (dto.dryRun) {
			// Validate inputs without mutating ClickUp.
			const repo = this.repoFromDto(dto);
			const ext = { ...this.emptyExtract(), ...(dto.extract ?? {}) };
			const plan = planRepo(repo, ext);
			return {
				projectId: "<dry-run>",
				folderId: "<dry-run>",
				folderUrl: "",
				spaceId: "<dry-run>",
				listIds: { overview: "", open_work: "", history: "" },
				hookSecret: "",
				taskCount: plan.tasks.length,
				alreadyTracked: false,
			};
		}

		// Resolve credentials.
		const creds = await this.credentials.forOrg(orgId);

		// Resolve / create the target Space.
		const spaceName = dto.spaceName ?? DEFAULT_SPACE_NAME;
		const spaces = await this.clickup.listSpaces(creds.team_id, creds.token);
		let space = spaces.find(
			(s) => s.name.toLowerCase() === spaceName.toLowerCase(),
		);
		if (!space) {
			this.log.log(`creating Space "${spaceName}" in team ${creds.team_id}`);
			space = await this.clickup.createSpace(
				creds.team_id,
				spaceName,
				creds.token,
			);
		}

		// Create or reuse Folder.
		const repo = this.repoFromDto(dto);
		const folderName = repo.displayName;
		const existingFolders = await this.clickup.listFolders(
			space.id,
			creds.token,
		);
		let folder = existingFolders.find((f) => f.name === folderName);
		if (!folder) {
			folder = await this.clickup.createFolder(
				space.id,
				folderName,
				creds.token,
			);
		}

		// Create or reuse the 3 standard Lists.
		const existingLists = await this.clickup.listListsInFolder(
			folder.id,
			creds.token,
		);
		const listIds: Record<ListKey, string> = {
			overview: "",
			open_work: "",
			history: "",
		};
		for (const key of Object.keys(LIST_NAMES) as ListKey[]) {
			const wantName = LIST_NAMES[key];
			const match = existingLists.find((l) => l.name === wantName);
			if (match) {
				listIds[key] = match.id;
			} else {
				const created = await this.clickup.createListInFolder(
					folder.id,
					wantName,
					creds.token,
				);
				listIds[key] = created.id;
			}
		}

		// Generate hook secret. Stored raw (managed Postgres encryption-at-rest);
		// returned once in the API response and never re-readable.
		const hookSecret = randomBytes(32).toString("hex");

		// Plan + create initial tasks if extract was supplied.
		// Defensively merge with defaults — a partial extract from a thin client
		// (e.g. only {readme, changelog}) would otherwise crash planRepo on the
		// missing array fields.
		const taskIndex: Record<string, string> = {};
		let plan: RepoPlan | null = null;
		if (dto.extract) {
			const ext = { ...this.emptyExtract(), ...dto.extract };
			plan = planRepo(repo, ext);
			for (const task of plan.tasks) {
				const created = await this.clickup.createTask(
					listIds[task.list],
					{ name: task.name, markdown_content: task.markdown_content },
					creds.token,
				);
				taskIndex[task.key] = created.id;

				if (task.comments) {
					for (const c of task.comments) {
						await this.clickup.addComment(created.id, c, creds.token);
					}
				}
			}
		}

		// Clear any soft-removed row at this (org, local_path) so the INSERT
		// below doesn't trip the unique constraint when a user re-registers a
		// previously untracked path.
		await this.prisma.$executeRawUnsafe(
			`DELETE FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid
         AND local_path = $2
         AND status = 'removed'`,
			orgId,
			dto.localPath,
		);

		// Persist the project row.
		const inserted = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`INSERT INTO clickup_tracker.projects (
        organisation_id, local_path, display_name, git_remote_url, scope_config,
        clickup_team_id, clickup_space_id, clickup_folder_id, list_ids,
        custom_field_ids, task_index, hook_secret, status, last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb,
              $10::jsonb, $11::jsonb, $12, 'active', NOW())
      RETURNING *`,
			orgId,
			dto.localPath,
			repo.displayName,
			dto.gitRemoteUrl ?? null,
			JSON.stringify({
				mode: dto.scopeMode ?? "root",
				paths: dto.scopePaths ?? [],
			}),
			creds.team_id,
			space.id,
			folder.id,
			JSON.stringify(listIds),
			JSON.stringify({}),
			JSON.stringify(taskIndex),
			hookSecret,
		);

		const row = inserted[0];
		this.log.log(
			`registered project ${row.id} (${repo.displayName}) → folder ${folder.id}`,
		);

		return {
			projectId: row.id,
			folderId: folder.id,
			folderUrl: this.folderUrl(creds.team_id, folder.id),
			spaceId: space.id,
			listIds,
			hookSecret,
			taskCount: Object.keys(taskIndex).length,
			alreadyTracked: false,
			scopeConfig: row.scope_config,
		};
	}

	/**
	 * Per-repo Space registration (Session 4): writes a placeholder project row
	 * with backfill_state='queued', enqueues a cup-backfill job, and returns
	 * immediately. Space, Folders, sprint Lists, Doc, views, and tasks are all
	 * created asynchronously by BackfillService walking planSpace().
	 */
	private async registerSpaceMode(
		orgId: string,
		dto: RegisterProjectDto,
	): Promise<RegisterResult> {
		const creds = await this.credentials.forOrg(orgId);
		const repo = this.repoFromDto(dto);
		const hookSecret = randomBytes(32).toString("hex");

		// Clear any soft-removed row at this (org, local_path).
		await this.prisma.$executeRawUnsafe(
			`DELETE FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid
         AND local_path = $2
         AND status = 'removed'`,
			orgId,
			dto.localPath,
		);

		const inserted = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`INSERT INTO clickup_tracker.projects (
        organisation_id, local_path, display_name, git_remote_url, scope_config,
        clickup_team_id, clickup_space_id, clickup_folder_id, list_ids,
        custom_field_ids, task_index, hook_secret, status, last_synced_at,
        backfill_state
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, '', '', $7::jsonb,
              $8::jsonb, $9::jsonb, $10, 'active', NOW(),
              $11::jsonb)
      RETURNING *`,
			orgId,
			dto.localPath,
			repo.displayName,
			dto.gitRemoteUrl ?? null,
			JSON.stringify({
				mode: dto.scopeMode ?? "root",
				paths: dto.scopePaths ?? [],
			}),
			creds.team_id,
			JSON.stringify({}),
			JSON.stringify({}),
			JSON.stringify({}),
			hookSecret,
			JSON.stringify({ status: "queued" }),
		);

		const row = inserted[0];
		await this.queue.addJob(
			"cup-backfill",
			{ projectId: row.id },
			{ jobId: `backfill:${row.id}`, attempts: 1 },
		);

		this.log.log(
			`registered project ${row.id} (${repo.displayName}) — backfill queued`,
		);
		return {
			projectId: row.id,
			folderId: "",
			folderUrl: "",
			spaceId: "",
			listIds: { overview: "", open_work: "", history: "" },
			hookSecret,
			taskCount: 0,
			alreadyTracked: false,
			scopeConfig: row.scope_config,
		};
	}

	async patch(
		orgId: string,
		projectId: string,
		dto: PatchProjectDto,
	): Promise<ProjectRow> {
		const existing = await this.get(orgId, projectId);
		const next = {
			display_name: dto.displayName ?? existing.display_name,
			status: dto.status ?? existing.status,
		};
		const rows = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`UPDATE clickup_tracker.projects
       SET display_name = $3, status = $4, updated_at = NOW()
       WHERE organisation_id = $1::uuid AND id = $2::uuid
       RETURNING *`,
			orgId,
			projectId,
			next.display_name,
			next.status,
		);
		// Plan §M.1 — operator-set GitHub webhook secret. Stored separately
		// so a future PR can rotate without re-PATCHing the whole row.
		if (dto.githubWebhookSecret !== undefined) {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET github_webhook_secret = $3, updated_at = NOW()
         WHERE organisation_id = $1::uuid AND id = $2::uuid`,
				orgId,
				projectId,
				dto.githubWebhookSecret,
			);
		}
		return rows[0];
	}

	/**
	 * Plan §N.10 — recent deployments for the active sprint slash command.
	 * Best-effort: returns empty when table missing or query errors.
	 */
	async recentDeployments(
		projectId: string,
		limit: number,
	): Promise<
		Array<{
			id: string;
			environment: string;
			status: string;
			commitSha: string | null;
			startedAt: string | null;
			finishedAt: string | null;
			cuTaskId: string | null;
		}>
	> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					id: string;
					environment: string;
					status: string;
					commit_sha: string | null;
					started_at: Date | null;
					finished_at: Date | null;
					cu_task_id: string | null;
				}>
			>(
				`SELECT id, environment, status, commit_sha,
				        started_at, finished_at, cu_task_id
				 FROM clickup_tracker.railway_deployments
				 WHERE project_id = $1::uuid
				 ORDER BY started_at DESC NULLS LAST
				 LIMIT $2`,
				projectId,
				limit,
			);
			return rows.map((r) => ({
				id: r.id,
				environment: r.environment,
				status: r.status,
				commitSha: r.commit_sha,
				startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
				finishedAt: r.finished_at
					? new Date(r.finished_at).toISOString()
					: null,
				cuTaskId: r.cu_task_id,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Plan §N.2 — bind a project to a Railway project + service set.
	 * Each field is optional; pass only what changed. `railwayProjectId`
	 * may be sent as `null` to clear the binding.
	 */
	async patchRailwayBinding(
		orgId: string,
		projectId: string,
		dto: {
			railwayProjectId?: string | null;
			railwayServiceIds?: string[];
			railwayEnvironments?: Record<string, string>;
		},
	): Promise<ProjectRow> {
		await this.get(orgId, projectId); // org-scope check
		const sets: string[] = [];
		const params: unknown[] = [orgId, projectId];
		if (dto.railwayProjectId !== undefined) {
			params.push(dto.railwayProjectId);
			sets.push(`railway_project_id = $${params.length}`);
		}
		if (dto.railwayServiceIds !== undefined) {
			params.push(JSON.stringify(dto.railwayServiceIds));
			sets.push(`railway_service_ids = $${params.length}::jsonb`);
		}
		if (dto.railwayEnvironments !== undefined) {
			params.push(JSON.stringify(dto.railwayEnvironments));
			sets.push(`railway_environments = $${params.length}::jsonb`);
		}
		if (sets.length === 0) return this.get(orgId, projectId);
		const rows = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`UPDATE clickup_tracker.projects
			 SET ${sets.join(", ")}, updated_at = NOW()
			 WHERE organisation_id = $1::uuid AND id = $2::uuid
			 RETURNING *`,
			...params,
		);
		return rows[0];
	}

	/**
	 * Plan §B.6 — flip a project to `auth-needed` when its CU writes
	 * fail with 401. The daemon's other write paths filter on
	 * `status='active'` so this halts emission without ripping out the
	 * project row. Idempotent: re-flipping a project already in
	 * `auth-needed` is a no-op (the WHERE clause filters).
	 *
	 * Recovery: operator updates env credentials + calls
	 * `POST /projects/:id/refresh-credentials` (which calls
	 * `clearAuthNeeded`).
	 */
	async flipToAuthNeeded(projectId: string, reason: string): Promise<void> {
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
				`flipToAuthNeeded(${projectId}) failed: ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §B.6 — flip a project back to `active` after operator-managed
	 * credential rotation. Pairs with `flipToAuthNeeded`.
	 */
	async clearAuthNeeded(
		orgId: string,
		projectId: string,
	): Promise<{ flipped: boolean; status: string }> {
		const rows = await this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
			`UPDATE clickup_tracker.projects
       SET status = 'active', updated_at = NOW()
       WHERE organisation_id = $1::uuid
         AND id = $2::uuid
         AND status = 'auth-needed'
       RETURNING status`,
			orgId,
			projectId,
		);
		if (rows.length === 0) {
			// Either the project doesn't exist, doesn't belong to this org,
			// or wasn't in auth-needed. Look up current status for the
			// caller's benefit.
			const probe = await this.prisma.$queryRawUnsafe<
				Array<{ status: string }>
			>(
				`SELECT status FROM clickup_tracker.projects
         WHERE organisation_id = $1::uuid AND id = $2::uuid`,
				orgId,
				projectId,
			);
			return { flipped: false, status: probe[0]?.status ?? "missing" };
		}
		this.log.log(`cleared auth-needed on project ${projectId}`);
		return { flipped: true, status: rows[0].status };
	}

	async remove(
		orgId: string,
		projectId: string,
		wipe = false,
	): Promise<{ removed: boolean; preRemoveBackupId: string | null }> {
		const project = await this.get(orgId, projectId);
		const creds = await this.credentials.forOrg(orgId);

		// Snapshot before destruction so /clickup-revert can resurrect.
		let preRemoveBackupId: string | null = null;
		try {
			const snap = await this.backups.take(projectId, "pre_remove");
			preRemoveBackupId = snap.id;
		} catch (err) {
			this.log.warn(`pre_remove backup failed: ${(err as Error).message}`);
		}

		if (wipe) {
			try {
				await this.clickup.deleteFolder(project.clickup_folder_id, creds.token);
			} catch (err) {
				// archiveFolder() used to be the fallback here, but ClickUp v2
				// PUT /folder/{id} silently ignores `archived: true` (verified
				// CARL CLICKUP_TRACKER_REWRITE-004). Nothing else to try; the
				// project row still gets soft-removed below so the daemon will
				// stop syncing to this folder.
				this.log.warn(
					`folder delete failed: ${(err as Error).message}; project will be soft-removed but the ClickUp folder will remain visible until manually deleted in the UI`,
				);
			}
		}
		// soft-remove (wipe=false): the folder stays in ClickUp untouched. The
		// project row's status='removed' update below stops sync; the user can
		// re-register the same path to reconnect. No `archiveFolder()` call —
		// it was a no-op against ClickUp v2.

		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET status = 'removed', updated_at = NOW()
       WHERE organisation_id = $1::uuid AND id = $2::uuid`,
			orgId,
			projectId,
		);
		return { removed: true, preRemoveBackupId };
	}

	// ── helpers ─────────────────────────────────────────────────

	private repoFromDto(dto: RegisterProjectDto): RepoEntry {
		if (dto.repoEntry) return dto.repoEntry;
		const name = dto.localPath.split("/").filter(Boolean).pop() ?? "project";
		return {
			path: dto.localPath,
			name,
			displayName: dto.displayName ?? humanise(name),
			stack: "Unknown",
			hasReadme: false,
			hasChangelog: false,
			stateFiles: [],
			isBackup: false,
			excluded: false,
			gitRemoteUrl: dto.gitRemoteUrl,
		};
	}

	private emptyExtract(): RepoExtract {
		return {
			readme: null,
			changelogEntries: [],
			stateEntries: [],
			todos: [],
			todosOverflow: 0,
			lastCommitISO: null,
			pkgMeta: null,
		};
	}

	private folderUrl(teamId: string, folderId: string): string {
		return `https://app.clickup.com/${teamId}/v/li/${folderId}`;
	}

	private toSummary(r: ProjectRow): ProjectSummary {
		return {
			id: r.id,
			localPath: r.local_path,
			displayName: r.display_name,
			status: r.status,
			folderUrl: this.folderUrl(r.clickup_team_id, r.clickup_folder_id),
			taskCount: Object.keys(r.task_index).length,
			lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
		};
	}
}

function humanise(slug: string): string {
	return slug.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}
