import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import {
	type ClickUpStatus,
	ClickUpDirectService,
} from "../clickup/clickup-direct.service";
import {
	CustomFieldsService,
	FIELDS_PER_LIST,
	type ListKey as CustomFieldListKey,
} from "../clickup/custom-fields";
import { seedDeploymentFields } from "../clickup/deployment-fields";
import { ViewsService } from "../clickup/views";
import { tagPalette } from "../util/tag-palette";
import { CredentialsService } from "../credentials/credentials.service";
import { GitHistoryExtractor } from "../extractors/git-history.extractor";
import { RepoExtractExtractor } from "../extractors/repo-extract.extractor";
import { mapInlineStatus, planSpace } from "../bulk/hierarchy";
import type {
	PlannedSpaceTask,
	RepoEntry,
	SpaceFolderPlan,
	SpacePlan,
} from "../bulk/types";
import {
	backfillState as backfillStateMetric,
	backfillTasksProcessed,
} from "../metrics/registry";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

const QUEUE_NAME = "cup-backfill";

interface BackfillJobPayload {
	projectId: string;
}

interface BackfillProjectRow {
	id: string;
	organisation_id: string;
	local_path: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	clickup_folder_id: string | null;
	clickup_doc_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	backfill_state: BackfillState;
	scope_config: { mode: string; paths?: string[] };
	git_remote_url: string | null;
	git_default_branch: string | null;
	template_status: string | null;
}

export interface BackfillState {
	status: "pending" | "queued" | "running" | "done" | "failed";
	processed?: number;
	total?: number;
	last_sha?: string | null;
	last_list?: string | null;
	started_at?: string | null;
	finished_at?: string | null;
	error_message?: string | null;
	space_url?: string | null;
	folder_url?: string | null;
}

interface MemberCacheRow {
	clickup_team_id: string;
	members_cache: Record<string, number>;
	members_cached_at: Date | null;
}

const MEMBER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TIME_ENTRIES_ENABLED =
	(process.env.CUP_BACKFILL_TIME_ENTRIES || "").toLowerCase() === "on";
const DEPENDENCIES_ENABLED =
	(process.env.CUP_BACKFILL_DEPENDENCIES || "on").toLowerCase() !== "off";

/**
 * Resumable, idempotent per-repo Space backfill orchestrator. Reads a fresh
 * server-side extract + git history from the local repo, runs `planSpace()`,
 * and walks the resulting `SpacePlan` against ClickUp via the (rate-limited)
 * direct service.
 *
 * Idempotency is enforced via `projects.task_index` — every entity write
 * skips when the key already maps to a ClickUp id. After every Sprint List
 * we checkpoint `backfill_state.last_list` so a crashed worker can resume.
 *
 * No ClickUp UI walkthrough required: planner emits a complete SpacePlan
 * with native fields populated; custom fields are Phase 2 only.
 */
@Injectable()
export class BackfillService implements OnModuleInit {
	private readonly log = new Logger(BackfillService.name);

	constructor(
		private readonly queue: QueueService,
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly customFields: CustomFieldsService,
		private readonly views: ViewsService,
		private readonly gitHistory: GitHistoryExtractor,
		private readonly repoExtract: RepoExtractExtractor,
	) {}

	onModuleInit(): void {
		this.queue.registerQueue(QUEUE_NAME, (job) => this.handle(job));
	}

	/** Enqueue a backfill for a project. Idempotent on jobId. */
	async enqueue(projectId: string): Promise<string> {
		const jobId = `backfill:${projectId}`;
		await this.queue.addJob(QUEUE_NAME, { projectId }, { jobId, attempts: 1 });
		return jobId;
	}

	private async handle(job: Job): Promise<void> {
		const { projectId } = job.data as BackfillJobPayload;
		try {
			await this.runFor(projectId);
		} catch (err) {
			this.log.error(`backfill ${projectId} failed: ${(err as Error).message}`);
			await this.persistState(projectId, {
				status: "failed",
				error_message: (err as Error).message,
				finished_at: new Date().toISOString(),
			});
			throw err;
		}
	}

	/**
	 * Public entry point. Runs the orchestrator end-to-end against the project.
	 * Safe to call again — every step checks `task_index` / existing
	 * Space/Folder/List ids before mutating.
	 */
	async runFor(projectId: string): Promise<BackfillState> {
		const project = await this.loadProject(projectId);
		if (!project) {
			throw new Error(`project ${projectId} not found`);
		}

		await this.persistState(projectId, {
			status: "running",
			started_at: project.backfill_state.started_at ?? new Date().toISOString(),
			error_message: null,
		});

		const creds = await this.credentials.forOrg(project.organisation_id);

		// Step 1 — fresh extract + history from disk.
		const [extract, history] = await Promise.all([
			this.repoExtract.extract(project.local_path),
			this.gitHistory.extract(project.local_path),
		]);

		const repo: RepoEntry = {
			path: project.local_path,
			name: project.display_name,
			displayName: project.display_name,
			stack: "Unknown",
			hasReadme: !!extract.readme,
			hasChangelog: extract.changelogEntries.length > 0,
			stateFiles: [],
			isBackup: false,
			excluded: false,
			gitRemoteUrl: project.git_remote_url ?? history.remote.url ?? undefined,
		};

		const plan = planSpace(repo, extract, history);

		// Step 2 — refresh members cache if stale.
		const members = await this.ensureMembers(creds.team_id, creds.token);

		// Step 3 — Space.
		const spaceId = await this.ensureSpace(project, plan, creds.token);

		// Step 4 — Space-level statuses.
		await this.safeSetStatuses(spaceId, plan.statuses, creds.token);

		// Step 5 — pre-create tags.
		await this.ensureTags(spaceId, plan.tags, creds.token);

		// Step 6 — folders + lists (static + sprint lists).
		const { listIdByKey, folderIdsByName } = await this.ensureFoldersAndLists(
			project,
			spaceId,
			plan.folders,
			creds.token,
		);

		// Step 6b — seed canonical custom fields per List + persist field id map.
		await this.ensureCustomFields(projectId, listIdByKey, creds.token);

		// Step 7 — Doc + pages (best-effort; non-fatal if v3 path rejects).
		await this.ensureDoc(project, spaceId, creds.team_id, plan, creds.token);

		// Step 8 — default views per List (best-effort; non-fatal).
		await this.ensureViews(plan, listIdByKey, creds.token);

		// Step 8b — Plan §J.2 — Folder-level views (Board + Calendar + Gantt
		// across the Active Work folder). Idempotent via getFolderViews;
		// failures debug-logged so non-paid tier doesn't break backfill.
		await this.ensureFolderViews(folderIdsByName, creds.token);

		// Step 8c — Plan §J.3 — Whiteboard scaffold (paid tier only). Failures
		// silently logged; URL persisted to projects.whiteboard_url when ok.
		await this.ensureWhiteboard(project, spaceId, creds.token);

		// Step 8d — Plan §J.4 — public bug-intake Form attached to the Bugs
		// List so non-developers can file structured bug reports without a
		// CU seat. URL persisted to projects.bug_form_url. Best-effort.
		await this.ensureBugForm(project, listIdByKey, creds.token);

		// Step 8e — Plan §J.5 — single recurring "Daily Triage" task on
		// open_work so humans see *one* recurring item instead of N daily
		// duplicates. Idempotent via task_index["recurring:daily_triage"].
		await this.ensureCeremonyRecurringTasks(project, listIdByKey, creds.token);

		// Step 8f — Plan §N.3 — 🚀 Deployments List + custom fields under
		// the Active Work folder. Skipped silently when RAILWAY_API_TOKEN is
		// unset; only consumed by RailwayPollCron when bound via PATCH.
		await this.ensureDeploymentsList(project, folderIdsByName, creds.token);

		// Step 9 — tasks.
		const totalTasks = plan.tasks.length;
		const taskIndex = { ...project.task_index };
		let processed = 0;
		const seenLists = new Set<string>();

		for (const task of plan.tasks) {
			const listId = listIdByKey[task.listKey];
			if (!listId) {
				this.log.warn(
					`task ${task.key} → list "${task.listKey}" not provisioned; skipping`,
				);
				processed++;
				continue;
			}
			if (taskIndex[task.key]) {
				processed++;
				continue;
			}
			try {
				const created = await this.clickup.createTask(
					listId,
					this.toCreateBody(
						task,
						members,
						task.parentKey,
						taskIndex,
						project.template_status,
					),
					creds.token,
				);
				taskIndex[task.key] = created.id;

				if (task.comments?.length) {
					for (const c of task.comments) {
						try {
							await this.clickup.addComment(created.id, c, creds.token);
						} catch (err) {
							this.log.debug(
								`comment on ${created.id} failed: ${(err as Error).message}`,
							);
						}
					}
				}
			} catch (err) {
				this.log.warn(
					`createTask ${task.key} failed: ${(err as Error).message}`,
				);
			}
			processed++;

			// Checkpoint after every Sprint List or every 25 tasks, whichever first.
			if (task.listKey.startsWith("sprint:")) {
				if (!seenLists.has(task.listKey)) {
					seenLists.add(task.listKey);
					await this.persistTaskIndex(projectId, taskIndex);
					await this.persistState(projectId, {
						status: "running",
						processed,
						total: totalTasks,
						last_sha: extractCommitSha(task.key),
						last_list: task.listKey,
						started_at: project.backfill_state.started_at ?? undefined,
					});
				}
			} else if (processed % 25 === 0) {
				await this.persistTaskIndex(projectId, taskIndex);
				await this.persistState(projectId, {
					status: "running",
					processed,
					total: totalTasks,
				});
			}
		}

		await this.persistTaskIndex(projectId, taskIndex);

		// Step 10 — assignee resolution for commit tasks.
		await this.assignAuthors(
			plan,
			listIdByKey,
			taskIndex,
			members,
			creds.token,
		);

		// Step 10b — Time Entries (opt-in via CUP_BACKFILL_TIME_ENTRIES=on).
		// One createTimeEntry per commit task using the planner's estimateMinutes
		// fallback. Off by default because each entry consumes a write call and
		// the cumulative cost on a 5000-commit cap is significant.
		if (TIME_ENTRIES_ENABLED) {
			await this.backfillTimeEntries(
				plan,
				taskIndex,
				members,
				creds.team_id,
				creds.token,
			);
		}

		// Step 10c — Dependencies between commit tasks and Agent Sessions tasks.
		// Cheap heuristic: if a session task exists and shares files with a commit,
		// link them. Default ON; toggle off via CUP_BACKFILL_DEPENDENCIES=off.
		if (DEPENDENCIES_ENABLED) {
			await this.linkSessionDependencies(plan, taskIndex, creds.token);
		}

		// Step 11 — finalise.
		const folderUrl = this.firstFolderUrl(creds.team_id, project, listIdByKey);
		const spaceUrl = `https://app.clickup.com/${creds.team_id}/v/s/${spaceId}`;

		const finalState: BackfillState = {
			status: "done",
			processed: totalTasks,
			total: totalTasks,
			finished_at: new Date().toISOString(),
			started_at: project.backfill_state.started_at ?? undefined,
			folder_url: folderUrl,
			space_url: spaceUrl,
		};
		await this.persistState(projectId, finalState);
		this.log.log(
			`backfill ${projectId} done: ${totalTasks} tasks across ${Object.keys(listIdByKey).length} lists`,
		);
		return finalState;
	}

	// ── orchestrator steps ────────────────────────────────────────

	private async ensureSpace(
		project: BackfillProjectRow,
		plan: SpacePlan,
		token: string,
	): Promise<string> {
		if (project.clickup_space_id) return project.clickup_space_id;
		const spaces = await this.clickup.listSpaces(
			project.clickup_team_id,
			token,
		);
		const existing = spaces.find(
			(s) => (s.name ?? "").toLowerCase() === plan.spaceName.toLowerCase(),
		);
		const space = existing
			? existing
			: await this.clickup.createSpace(
					project.clickup_team_id,
					plan.spaceName,
					token,
					{
						features: plan.features,
						multiple_assignees: plan.multipleAssignees,
						statuses: plan.statuses as ClickUpStatus[],
					},
				);
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects SET clickup_space_id = $1, updated_at = NOW() WHERE id = $2::uuid`,
			space.id,
			project.id,
		);
		return space.id;
	}

	private async safeSetStatuses(
		spaceId: string,
		statuses: {
			status: string;
			color?: string;
			type?: string;
			orderindex?: number;
		}[],
		token: string,
	): Promise<void> {
		try {
			await this.clickup.setSpaceStatuses(
				spaceId,
				statuses as ClickUpStatus[],
				token,
			);
		} catch (err) {
			this.log.warn(`setSpaceStatuses failed: ${(err as Error).message}`);
		}
	}

	private async ensureTags(
		spaceId: string,
		want: string[],
		token: string,
	): Promise<void> {
		let existing: Array<{ name: string }> = [];
		try {
			existing = await this.clickup.listSpaceTags(spaceId, token);
		} catch (err) {
			this.log.warn(`listSpaceTags failed: ${(err as Error).message}`);
			return;
		}
		const have = new Set(existing.map((t) => (t.name ?? "").toLowerCase()));
		for (const name of want) {
			if (have.has(name.toLowerCase())) continue;
			const { fg, bg } = tagPalette(name);
			try {
				await this.clickup.createSpaceTag(spaceId, name, token, fg, bg);
			} catch (err) {
				this.log.debug(
					`createSpaceTag(${name}) failed: ${(err as Error).message}`,
				);
			}
		}
	}

	/**
	 * Seed canonical custom fields per List. Idempotent (re-uses existing
	 * fields by name). Persists `{listKey: {fieldKey: fieldId}}` to
	 * `projects.custom_field_ids`. Best-effort — per-List failures logged
	 * but never fatal.
	 */
	private async ensureCustomFields(
		projectId: string,
		listIdByKey: Record<string, string>,
		token: string,
	): Promise<void> {
		for (const listKey of Object.keys(
			FIELDS_PER_LIST,
		) as CustomFieldListKey[]) {
			const listId = listIdByKey[listKey];
			if (!listId) continue;
			const ids = await this.customFields.seedFieldsForList(
				listId,
				listKey,
				token,
			);
			if (Object.keys(ids).length > 0) {
				await this.customFields.persistFieldIds(projectId, listKey, ids);
			}
		}
		// Sprint history Lists share active_sprint's field schema.
		for (const [key, listId] of Object.entries(listIdByKey)) {
			if (!key.startsWith("sprint:")) continue;
			const ids = await this.customFields.seedFieldsForList(
				listId,
				"active_sprint",
				token,
			);
			if (Object.keys(ids).length > 0) {
				await this.customFields.persistFieldIds(
					projectId,
					`sprint:${key.slice("sprint:".length)}` as CustomFieldListKey,
					ids,
				);
			}
		}
	}

	/**
	 * Plan §J.2 — Folder-level Board/Calendar/Gantt views (best-effort).
	 * Whiteboards / Forms / Folder views all 4xx on lower tiers; we never
	 * propagate. Idempotency via getFolderViews case-insensitive name match.
	 */
	private async ensureFolderViews(
		folderIdsByName: Record<string, string>,
		token: string,
	): Promise<void> {
		// We attach to the "🚧 Active Work" folder when present (matches
		// hierarchy.ts canonical name). Multi-folder support is trivial to
		// extend later — current scope is one Folder of cross-List rollup.
		const activeFolderId = folderIdsByName["🚧 Active Work"];
		if (!activeFolderId) return;
		try {
			const existing = await this.clickup.getFolderViews(activeFolderId, token);
			const existingNames = new Set(existing.map((v) => v.name.toLowerCase()));
			const targets: Array<{
				name: string;
				type: "board" | "calendar" | "gantt";
			}> = [
				{ name: "Folder Board", type: "board" },
				{ name: "Folder Calendar", type: "calendar" },
				{ name: "Folder Timeline", type: "gantt" },
			];
			for (const t of targets) {
				if (existingNames.has(t.name.toLowerCase())) continue;
				try {
					await this.clickup.createFolderView(
						activeFolderId,
						{ name: t.name, type: t.type },
						token,
					);
				} catch (err) {
					this.log.debug(
						`createFolderView(${t.name}) failed: ${(err as Error).message}`,
					);
				}
			}
		} catch (err) {
			this.log.debug(
				`ensureFolderViews failed (folder ${activeFolderId}): ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §J.3 — Whiteboards scaffold. Best-effort: whiteboard creation
	 * is paid-tier; non-Business workspaces 4xx. Persist the URL to
	 * projects.whiteboard_url so the Dashboard Doc page can link to it.
	 */
	private async ensureWhiteboard(
		project: BackfillProjectRow,
		spaceId: string,
		token: string,
	): Promise<void> {
		// Skip when one already attached (idempotent across replans).
		const existing = await this.prisma.$queryRawUnsafe<
			Array<{ whiteboard_url: string | null }>
		>(
			`SELECT whiteboard_url FROM clickup_tracker.projects WHERE id = $1::uuid`,
			project.id,
		);
		if (existing[0]?.whiteboard_url) return;
		try {
			const wb = await this.clickup.createWhiteboard(
				spaceId,
				{
					name: `${project.display_name} — Architecture Map`,
					description:
						"Auto-created by clickup-tracker. Pre-populate with module nodes.",
				},
				token,
			);
			const url = `https://app.clickup.com/${project.clickup_team_id ?? ""}/v/v/${wb.id}`;
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects SET whiteboard_url = $1, updated_at = NOW() WHERE id = $2::uuid`,
				url,
				project.id,
			);
		} catch (err) {
			this.log.debug(
				`ensureWhiteboard failed (likely paid-tier): ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §J.4 — public bug-intake Form scaffold. Attaches a Form view to
	 * the Bugs List on first scaffold. Idempotent via the persisted
	 * bug_form_url (skip when already set).
	 */
	private async ensureBugForm(
		project: BackfillProjectRow,
		listIdByKey: Record<string, string>,
		token: string,
	): Promise<void> {
		const bugsListId = listIdByKey["bugs"];
		if (!bugsListId) return;
		const existing = await this.prisma.$queryRawUnsafe<
			Array<{ bug_form_url: string | null }>
		>(
			`SELECT bug_form_url FROM clickup_tracker.projects WHERE id = $1::uuid`,
			project.id,
		);
		if (existing[0]?.bug_form_url) return;
		try {
			const form = await this.clickup.createForm(
				bugsListId,
				{
					name: `${project.display_name} — Report a Bug`,
					settings: {
						// Public, no login required.
						public: true,
					},
				},
				token,
			);
			const url = form.url ?? `https://app.clickup.com/forms/${form.id}`;
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects SET bug_form_url = $1, updated_at = NOW() WHERE id = $2::uuid`,
				url,
				project.id,
			);
		} catch (err) {
			this.log.debug(
				`ensureBugForm failed (likely tier-gated): ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §J.5 — create ONE recurring task per ceremony so the team sees
	 * a single visible item in CU instead of N daily duplicates. Idempotent
	 * via task_index["recurring:daily_triage"]; skip when already created.
	 */
	private async ensureCeremonyRecurringTasks(
		project: BackfillProjectRow,
		listIdByKey: Record<string, string>,
		token: string,
	): Promise<void> {
		const owListId = listIdByKey["open_work"];
		if (!owListId) return;
		const indexKey = "recurring:daily_triage";
		if (project.task_index?.[indexKey]) return;
		try {
			const created = await this.clickup.createRecurringTask(
				owListId,
				{
					name: "📋 Daily Triage",
					markdown_content:
						"_Auto-managed by clickup-tracker. The groomer cron updates this task daily with newly-flagged duplicates, stale bugs, hotspots, and re-prioritisation suggestions._",
					priority: 3,
					recurring: {
						interval: "daily",
						start: Date.now(),
					},
				},
				token,
			);
			// Inline jsonb_set so we don't have to read-merge-write the whole map.
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
				 SET task_index = jsonb_set(
				   COALESCE(task_index, '{}'::jsonb),
				   $2,
				   to_jsonb($3::text),
				   true
				 ),
				 updated_at = NOW()
				 WHERE id = $1::uuid`,
				project.id,
				`{${indexKey}}`,
				created.id,
			);
		} catch (err) {
			this.log.debug(
				`ensureCeremonyRecurringTasks failed: ${(err as Error).message}`,
			);
		}
	}

	/**
	 * Plan §N.3 + §N.6 — provision the 🚀 Deployments List under the
	 * Active Work folder + seed deployment custom fields. Idempotent:
	 * lookup-by-name first, persist `deployments_list_id` and merge
	 * field IDs into `custom_field_ids.deployments`.
	 *
	 * Pure scaffold: no Railway API calls happen here. Polling cron
	 * picks up the bound projects via `PATCH /projects/:id/railway`.
	 */
	private async ensureDeploymentsList(
		project: BackfillProjectRow,
		folderIdsByName: Record<string, string>,
		token: string,
	): Promise<void> {
		const folderId = folderIdsByName["🚧 Active Work"];
		if (!folderId) return;
		try {
			const existing = await this.prisma.$queryRawUnsafe<
				Array<{ deployments_list_id: string | null }>
			>(
				`SELECT deployments_list_id FROM clickup_tracker.projects
				 WHERE id = $1::uuid`,
				project.id,
			);
			let listId = existing[0]?.deployments_list_id ?? null;
			if (!listId) {
				const lists = await this.clickup.listListsInFolder(folderId, token);
				const found = lists.find((l) => l.name.trim() === "🚀 Deployments");
				if (found) {
					listId = found.id;
				} else {
					const created = await this.clickup.createListInFolder(
						folderId,
						"🚀 Deployments",
						token,
					);
					listId = created.id;
				}
				await this.prisma.$executeRawUnsafe(
					`UPDATE clickup_tracker.projects
					 SET deployments_list_id = $1, updated_at = NOW()
					 WHERE id = $2::uuid`,
					listId,
					project.id,
				);
			}
			const seed = await seedDeploymentFields(this.clickup, listId, token);
			if (Object.keys(seed.ids).length > 0) {
				await this.prisma.$executeRawUnsafe(
					`UPDATE clickup_tracker.projects
					 SET custom_field_ids = jsonb_set(
					       COALESCE(custom_field_ids, '{}'::jsonb),
					       '{deployments}',
					       $1::jsonb,
					       true
					     ),
					     updated_at = NOW()
					 WHERE id = $2::uuid`,
					JSON.stringify(seed.ids),
					project.id,
				);
			}
		} catch (err) {
			this.log.debug(`ensureDeploymentsList failed: ${(err as Error).message}`);
		}
	}

	private async ensureFoldersAndLists(
		project: BackfillProjectRow,
		spaceId: string,
		folders: SpaceFolderPlan[],
		token: string,
	): Promise<{
		listIdByKey: Record<string, string>;
		folderIdsByName: Record<string, string>;
	}> {
		const listIdByKey: Record<string, string> = { ...project.list_ids };
		// Merge sprint_lists into the same map for lookup.
		for (const [key, id] of Object.entries(project.sprint_lists ?? {})) {
			listIdByKey[`sprint:${key}`] = id;
		}

		const existingFolders = await this.clickup.listFolders(spaceId, token);
		let firstFolderId: string | null = project.clickup_folder_id;
		// Plan §J.2 — capture each Folder's ID by canonical name so the
		// folder-view seeder (PR-8) can attach Board / Calendar / Gantt
		// views at the Folder scope without re-listing.
		const folderIdsByName: Record<string, string> = {};

		for (const folder of folders) {
			let existingFolder = existingFolders.find((f) => f.name === folder.name);
			if (!existingFolder) {
				existingFolder = await this.clickup.createFolder(
					spaceId,
					folder.name,
					token,
				);
			}
			if (!firstFolderId) firstFolderId = existingFolder.id;
			folderIdsByName[folder.name] = existingFolder.id;

			const existingLists = await this.clickup.listListsInFolder(
				existingFolder.id,
				token,
			);
			for (const list of folder.lists) {
				const wantName = list.name;
				let match = existingLists.find((l) => l.name === wantName);
				if (!match) {
					match = await this.clickup.createListInFolder(
						existingFolder.id,
						wantName,
						token,
					);
				}
				listIdByKey[list.key] = match.id;
				if (list.statusOverrides && list.statusOverrides.length > 0) {
					try {
						await this.clickup.setListStatuses(
							match.id,
							list.statusOverrides as ClickUpStatus[],
							token,
						);
					} catch (err) {
						this.log.debug(
							`setListStatuses(${match.id}) failed: ${(err as Error).message}`,
						);
					}
				}
			}
		}

		// Persist resolved ids back to the project row.
		const sprintLists: Record<string, string> = {};
		const flatListIds: Record<string, string> = {};
		for (const [key, id] of Object.entries(listIdByKey)) {
			if (key.startsWith("sprint:")) {
				sprintLists[key.slice("sprint:".length)] = id;
			} else {
				flatListIds[key] = id;
			}
		}
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects SET
        clickup_folder_id = COALESCE(clickup_folder_id, $1),
        list_ids = $2::jsonb,
        sprint_lists = $3::jsonb,
        updated_at = NOW()
      WHERE id = $4::uuid`,
			firstFolderId,
			JSON.stringify(flatListIds),
			JSON.stringify(sprintLists),
			project.id,
		);
		return { listIdByKey, folderIdsByName };
	}

	private async ensureDoc(
		project: BackfillProjectRow,
		spaceId: string,
		teamId: string,
		plan: SpacePlan,
		token: string,
	): Promise<void> {
		if (project.clickup_doc_id) return;

		// Plan §A.2: persist clickup_doc_id IMMEDIATELY after createDoc succeeds.
		// A page-creation failure later in the loop must NOT bypass the docId
		// persistence — otherwise the daemon permanently regresses (Doc exists
		// in CU but the daemon doesn't know about it; tryAppendChangelogPage
		// becomes a permanent no-op). Each page failure is non-fatal and
		// recorded in backfill_state.errors[] so operators can see partial work.
		let docId: string;
		try {
			const doc = await this.clickup.createDoc(
				teamId,
				{
					name: plan.doc.name,
					parent: { id: spaceId, type: 4 },
					visibility: "PRIVATE",
					create_page: false,
				},
				token,
			);
			docId = doc.id;
		} catch (err) {
			this.log.warn(`createDoc failed: ${(err as Error).message}`);
			await this.appendBackfillError(project.id, "createDoc", err);
			return;
		}

		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects SET clickup_doc_id = $1, updated_at = NOW() WHERE id = $2::uuid`,
			docId,
			project.id,
		);

		for (const page of plan.doc.pages) {
			try {
				await this.clickup.createDocPage(
					teamId,
					docId,
					{ name: page.name, content: page.markdown },
					token,
				);
			} catch (err) {
				this.log.warn(
					`createDocPage(${page.name}) failed: ${(err as Error).message}`,
				);
				await this.appendBackfillError(
					project.id,
					`createDocPage:${page.name}`,
					err,
				);
			}
		}
	}

	/**
	 * Append a structured entry to backfill_state.errors[]. Used by ensureDoc
	 * (and any later step that wants to surface non-fatal failures via the
	 * GET /:id/backfill endpoint instead of just log warns).
	 */
	private async appendBackfillError(
		projectId: string,
		op: string,
		err: unknown,
	): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET backfill_state = jsonb_set(
           COALESCE(backfill_state, '{}'::jsonb),
           '{errors}',
           COALESCE(backfill_state->'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'op', $2::text,
             'message', $3::text,
             'at', NOW()::text
           )),
           true
         ),
         updated_at = NOW()
         WHERE id = $1::uuid`,
				projectId,
				op,
				message,
			);
		} catch (writeErr) {
			this.log.debug(
				`appendBackfillError(${op}) write failed: ${(writeErr as Error).message}`,
			);
		}
	}

	private async ensureViews(
		plan: SpacePlan,
		listIdByKey: Record<string, string>,
		token: string,
	): Promise<void> {
		// Plan-emitted views first (legacy + extractor-driven). Idempotent
		// per-list dedupe is handled below by ViewsService for v0.4.0
		// canonical views; planner-emitted ones may duplicate on re-runs
		// (best-effort, debug-logged).
		for (const view of plan.views) {
			const listId = listIdByKey[view.listKey];
			if (!listId) continue;
			try {
				await this.clickup.createListView(
					listId,
					{
						name: view.name,
						type: view.type,
						grouping: view.grouping,
						sorting: view.sorting,
						filters: view.filters,
					},
					token,
				);
			} catch (err) {
				this.log.debug(
					`createListView(${view.name}) failed: ${(err as Error).message}`,
				);
			}
		}

		// v0.4.0 canonical view set per List (Board/Calendar/Gantt etc.).
		// Idempotent against re-run.
		for (const listKey of Object.keys(listIdByKey) as CustomFieldListKey[]) {
			const listId = listIdByKey[listKey];
			if (!listId) continue;
			if (listKey.startsWith("sprint:")) {
				await this.views.seedViewsForList(listId, "sprint", token);
			} else {
				await this.views.seedViewsForList(listId, listKey, token);
			}
		}
	}

	private async assignAuthors(
		plan: SpacePlan,
		listIdByKey: Record<string, string>,
		taskIndex: Record<string, string>,
		members: Record<string, number>,
		token: string,
	): Promise<void> {
		for (const task of plan.tasks) {
			if (!task.assigneeEmails?.length) continue;
			const taskId = taskIndex[task.key];
			if (!taskId) continue;
			const userIds = task.assigneeEmails
				.map((e) => members[e.toLowerCase()])
				.filter((id): id is number => typeof id === "number");
			if (userIds.length === 0) continue;
			try {
				await this.clickup.assignTask(taskId, userIds, [], token);
			} catch (err) {
				this.log.debug(
					`assignTask(${taskId}) failed: ${(err as Error).message}`,
				);
			}
		}
	}

	// ── Time Entries (opt-in via CUP_BACKFILL_TIME_ENTRIES=on) ──

	private async backfillTimeEntries(
		plan: SpacePlan,
		taskIndex: Record<string, string>,
		members: Record<string, number>,
		teamId: string,
		token: string,
	): Promise<void> {
		for (const task of plan.tasks) {
			if (!task.key.startsWith("commit:")) continue;
			const taskId = taskIndex[task.key];
			if (!taskId) continue;
			if (!task.timeEstimateMs || !task.startDateMs) continue;
			const assignee =
				task.assigneeEmails
					?.map((e) => members[e.toLowerCase()])
					.find((id): id is number => typeof id === "number") ?? undefined;
			try {
				await this.clickup.createTimeEntry(
					teamId,
					{
						tid: taskId,
						start: task.startDateMs,
						duration: task.timeEstimateMs,
						description: `Backfilled by clickup-tracker (${task.key})`,
						assignee,
						billable: false,
					},
					token,
				);
			} catch (err) {
				this.log.debug(
					`createTimeEntry(${task.key}) failed: ${(err as Error).message}`,
				);
			}
		}
	}

	// ── Dependencies — commit ↔ session linkage ─────────────────

	private async linkSessionDependencies(
		plan: SpacePlan,
		taskIndex: Record<string, string>,
		token: string,
	): Promise<void> {
		// Group commit tasks by their first changed file path's top-level dir.
		// If any session task shares that prefix, link commit dependency_of session.
		const commitsByPrefix = new Map<string, string[]>();
		for (const task of plan.tasks) {
			if (!task.key.startsWith("commit:")) continue;
			const id = taskIndex[task.key];
			if (!id) continue;
			const prefix = extractTopDirFromName(task.name);
			if (!prefix) continue;
			const arr = commitsByPrefix.get(prefix) ?? [];
			arr.push(id);
			commitsByPrefix.set(prefix, arr);
		}

		for (const task of plan.tasks) {
			if (!task.key.startsWith("session:")) continue;
			const sessionId = taskIndex[task.key];
			if (!sessionId) continue;
			// Heuristic: link any commit prefix that appears in the session name.
			for (const [prefix, commitIds] of commitsByPrefix) {
				if (!task.name.toLowerCase().includes(prefix.toLowerCase())) continue;
				for (const commitId of commitIds.slice(0, 5)) {
					try {
						await this.clickup.addDependency(
							commitId,
							{ dependency_of: sessionId },
							token,
						);
					} catch (err) {
						this.log.debug(
							`addDependency(${commitId}↔${sessionId}) failed: ${(err as Error).message}`,
						);
					}
				}
			}
		}
	}

	private async ensureMembers(
		teamId: string,
		token: string,
	): Promise<Record<string, number>> {
		const rows = await this.prisma.$queryRawUnsafe<MemberCacheRow[]>(
			`SELECT clickup_team_id, members_cache, members_cached_at
       FROM clickup_tracker.workspace_settings
       WHERE clickup_team_id = $1`,
			teamId,
		);
		const fresh =
			rows[0]?.members_cached_at &&
			Date.now() - new Date(rows[0].members_cached_at).getTime() <
				MEMBER_CACHE_TTL_MS;
		if (fresh) return rows[0].members_cache ?? {};

		let members: Record<string, number> = {};
		let listOk = false;
		try {
			const list = await this.clickup.listMembers(teamId, token);
			for (const m of list) {
				if (m.email) members[m.email.toLowerCase()] = m.id;
			}
			listOk = true;
		} catch (err) {
			this.log.warn(`listMembers failed: ${(err as Error).message}`);
		}

		// Plan §B.9 — when the refresh succeeds, diff against the prior
		// cache. Emails that were tracked but no longer in the workspace
		// are appended to each project's `scrum_config.members_offboarded`
		// so the daily groomer can flag their assignments for reassignment.
		if (listOk) {
			const previous = rows[0]?.members_cache ?? {};
			const removed = diffOffboardedEmails(previous, members);
			if (removed.length > 0) {
				await this.recordOffboardedMembers(teamId, removed);
			}
		}

		await this.prisma.$executeRawUnsafe(
			`INSERT INTO clickup_tracker.workspace_settings
        (clickup_team_id, members_cache, members_cached_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (clickup_team_id) DO UPDATE
        SET members_cache = EXCLUDED.members_cache,
            members_cached_at = EXCLUDED.members_cached_at,
            updated_at = NOW()`,
			teamId,
			JSON.stringify(members),
		);
		return members;
	}

	/**
	 * Plan §B.9 — append offboarded emails to every team-member project's
	 * `scrum_config.members_offboarded` array. Uses a JSONB set-union
	 * pattern so re-running on the same email is idempotent.
	 */
	private async recordOffboardedMembers(
		teamId: string,
		emails: string[],
	): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET scrum_config = jsonb_set(
               COALESCE(scrum_config, '{}'::jsonb),
               '{members_offboarded}',
               (
                 SELECT to_jsonb(ARRAY(
                   SELECT DISTINCT email
                   FROM unnest(
                     ARRAY(
                       SELECT jsonb_array_elements_text(
                         COALESCE(scrum_config->'members_offboarded', '[]'::jsonb)
                       )
                     ) || $2::text[]
                   ) AS email
                 ))
               ),
               true
             ),
             updated_at = NOW()
         WHERE clickup_team_id = $1
           AND status = 'active'`,
				teamId,
				emails,
			);
			this.log.warn(
				`offboarded ${emails.length} member(s) from workspace ${teamId}: ${emails.join(", ")}`,
			);
		} catch (err) {
			this.log.warn(
				`recordOffboardedMembers(${teamId}) failed: ${(err as Error).message}`,
			);
		}
	}

	// ── persistence helpers ───────────────────────────────────────

	private async loadProject(
		projectId: string,
	): Promise<BackfillProjectRow | null> {
		const rows = await this.prisma.$queryRawUnsafe<BackfillProjectRow[]>(
			`SELECT id, organisation_id, local_path, display_name,
              clickup_team_id, clickup_space_id, clickup_folder_id,
              clickup_doc_id, list_ids, sprint_lists, task_index,
              backfill_state, scope_config, git_remote_url, git_default_branch,
              template_status
       FROM clickup_tracker.projects
       WHERE id = $1::uuid`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async persistState(
		projectId: string,
		patch: Partial<BackfillState>,
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
         SET backfill_state = backfill_state || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2::uuid`,
			JSON.stringify(patch),
			projectId,
		);
		// Mirror state into the gauge: 1 for the new status, 0 for all others.
		if (patch.status) {
			for (const s of ["queued", "running", "done", "failed"] as const) {
				backfillStateMetric.set(
					{ project_id: projectId, status: s },
					s === patch.status ? 1 : 0,
				);
			}
		}
		if (typeof patch.processed === "number" && patch.processed >= 0) {
			backfillTasksProcessed.inc(
				{ project_id: projectId, outcome: "processed" },
				0, // no-op increment to ensure the series exists
			);
		}
	}

	private async persistTaskIndex(
		projectId: string,
		taskIndex: Record<string, string>,
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
         SET task_index = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid`,
			JSON.stringify(taskIndex),
			projectId,
		);
	}

	private toCreateBody(
		task: PlannedSpaceTask,
		members: Record<string, number>,
		parentKey: string | undefined,
		taskIndex: Record<string, string>,
		templateStatus: string | null,
	): import("../clickup/clickup-direct.service").CreateTaskBody {
		const assignees =
			task.assigneeEmails
				?.map((e) => members[e.toLowerCase()])
				.filter((id): id is number => typeof id === "number") ?? [];
		const parentId = parentKey ? taskIndex[parentKey] : undefined;
		const status =
			templateStatus === "configured"
				? task.status
				: mapInlineStatus(task.status);
		return {
			name: task.name,
			markdown_content: task.markdown_content,
			status,
			tags: task.tags,
			priority: task.priority,
			start_date: task.startDateMs,
			due_date: task.dueDateMs,
			points: task.points,
			time_estimate: task.timeEstimateMs,
			assignees: assignees.length > 0 ? assignees : undefined,
			parent: parentId,
			notify_all: false,
		};
	}

	private firstFolderUrl(
		teamId: string,
		project: BackfillProjectRow,
		listIdByKey: Record<string, string>,
	): string | null {
		// Prefer the Active Sprint List view URL — that's where users want to land.
		const activeId = listIdByKey["active_sprint"];
		if (activeId) return `https://app.clickup.com/${teamId}/v/li/${activeId}`;
		if (project.clickup_folder_id) {
			return `https://app.clickup.com/${teamId}/v/f/${project.clickup_folder_id}`;
		}
		return null;
	}

	/** Public read of backfill state (used by the controller). */
	async getState(projectId: string): Promise<BackfillState | null> {
		const rows = await this.prisma.$queryRawUnsafe<
			{
				backfill_state: BackfillState;
			}[]
		>(
			`SELECT backfill_state FROM clickup_tracker.projects WHERE id = $1::uuid`,
			projectId,
		);
		return rows[0]?.backfill_state ?? null;
	}
}

function extractCommitSha(taskKey: string): string | null {
	const m = /^commit:([0-9a-f]{7,40})/.exec(taskKey);
	return m ? m[1] : null;
}

/**
 * Plan §B.9 — return the set of emails present in `previous` that are
 * absent from `current`. Case-insensitive (matches how
 * `ensureMembers` lower-cases on insert). Empty arrays are tolerated
 * on either side.
 */
export function diffOffboardedEmails(
	previous: Record<string, unknown>,
	current: Record<string, unknown>,
): string[] {
	const presentNow = new Set(Object.keys(current).map((e) => e.toLowerCase()));
	const removed: string[] = [];
	for (const email of Object.keys(previous)) {
		if (!presentNow.has(email.toLowerCase())) removed.push(email.toLowerCase());
	}
	return removed;
}

/** Extract the first scope/path-prefix token from a planned commit task name.
 * Names look like "[2026-04-22] Feature(api): new endpoint" — scope is "api".
 * Falls back to the second word if no `(scope)` is present. */
function extractTopDirFromName(name: string): string | null {
	const scope = /\(([^)]+)\)/.exec(name);
	if (scope) return scope[1];
	const words = name
		.replace(/^\[[^\]]+\]\s*/, "")
		.split(/[:\s]/)
		.filter(Boolean);
	return words[1] ?? null;
}
