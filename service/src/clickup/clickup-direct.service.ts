import {
	BadGatewayException,
	HttpException,
	HttpStatus,
	Injectable,
	Logger,
	UnauthorizedException,
} from "@nestjs/common";
import { currentPriority } from "./priority-context";
import { ClickUpRateLimiter, bucketKeyForToken } from "./rate-limiter";

const V2_BASE =
	process.env.CLICKUP_API_BASE || "https://api.clickup.com/api/v2";
const V3_BASE =
	process.env.CLICKUP_API_V3_BASE || "https://api.clickup.com/api/v3";

const RETRY_5XX_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_5XX_RETRIES = 5;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ClickUpFolder {
	id: string;
	name: string;
}
export interface ClickUpList {
	id: string;
	name: string;
}
export interface ClickUpSpace {
	id: string;
	name: string;
}
export interface ClickUpTask {
	id: string;
	name: string;
	url?: string;
}
export interface ClickUpTaskFull {
	id: string;
	name: string;
	text_content?: string;
	description?: string;
	// ClickUp's GET responses still expose `markdown_description`; writes use `markdown_content`.
	markdown_description?: string;
	status?: { status: string; type?: string };
	url?: string;
	list?: { id: string };
	custom_fields?: Array<{ id: string; name?: string; value?: unknown }>;
	date_created?: string;
}
export interface ClickUpStatus {
	status: string;
	color?: string;
	type?: "open" | "custom" | "closed" | "done";
	orderindex?: number;
}
export interface ClickUpCustomField {
	id: string;
	name?: string;
	type?: string;
	value?: unknown;
}
export interface ClickUpMember {
	id: number;
	username?: string;
	email?: string;
}
export interface ClickUpView {
	id: string;
	name?: string;
	type?: string;
}
export interface ClickUpWebhook {
	id: string;
	secret: string;
}

export interface CreateTaskBody {
	name: string;
	/** Preferred. */
	markdown_content?: string;
	/** Deprecated alias — translated to markdown_content on the wire. */
	markdown_description?: string;
	status?: string;
	tags?: string[];
	priority?: 1 | 2 | 3 | 4;
	assignees?: number[];
	start_date?: number;
	due_date?: number;
	points?: number;
	time_estimate?: number;
	parent?: string;
	custom_fields?: Array<{ id: string; value: unknown }>;
	notify_all?: boolean;
}

export interface UpdateTaskBody {
	name?: string;
	/** Preferred. */
	markdown_content?: string;
	/** Deprecated alias — translated to markdown_content on the wire. */
	markdown_description?: string;
	description?: string;
	status?: string;
	priority?: 1 | 2 | 3 | 4;
	start_date?: number;
	due_date?: number;
	points?: number;
	time_estimate?: number;
	assignees?: { add?: number[]; rem?: number[] };
}

/**
 * Direct (non-queued) ClickUp API client. Used by the synchronous parts of
 * register/restore/lifecycle flows where we need IDs back inline. The async
 * heavy lifting (backfill orchestration, webhook fan-out) goes through
 * BullMQ queues, which still call this client one request at a time —
 * the in-process token bucket protects ClickUp's 100 req/min ceiling
 * regardless of caller.
 *
 * Per CARL CLICKUP_TRACKER_REWRITE rule #6: every mutating call (POST/PUT/
 * DELETE) acquires a rate-limit slot before issuing the HTTP request; reads
 * (GET) bypass the limiter. Rule #2 forbids third-party libs, so the
 * limiter is in-house (rate-limiter.ts).
 */
@Injectable()
export class ClickUpDirectService {
	private readonly log = new Logger(ClickUpDirectService.name);

	constructor(private readonly limiter: ClickUpRateLimiter) {}

	// ---------- spaces ----------

	async listSpaces(teamId: string, token: string): Promise<ClickUpSpace[]> {
		const r = await this.fetchV2<{ spaces: ClickUpSpace[] }>(
			`/team/${teamId}/space?archived=false`,
			token,
		);
		return r.spaces;
	}

	async createSpace(
		teamId: string,
		name: string,
		token: string,
		options?: {
			features?: Record<string, unknown>;
			multiple_assignees?: boolean;
			statuses?: ClickUpStatus[];
		},
	): Promise<ClickUpSpace> {
		const body: Record<string, unknown> = {
			name,
			multiple_assignees: options?.multiple_assignees ?? true,
			features: options?.features ?? {
				due_dates: {
					enabled: true,
					start_date: true,
					remap_due_dates: true,
					remap_closed_due_date: false,
				},
				time_tracking: { enabled: true },
				tags: { enabled: true },
				time_estimates: { enabled: true },
				checklists: { enabled: true },
				custom_fields: { enabled: true },
				dependency_warning: { enabled: true },
				sprints: { enabled: true },
				points: { enabled: true },
				milestones: { enabled: true },
			},
		};
		if (options?.statuses && options.statuses.length > 0) {
			body.statuses = options.statuses;
		}
		return this.fetchV2<ClickUpSpace>(
			`/team/${teamId}/space`,
			token,
			"POST",
			body,
		);
	}

	/**
	 * Replace the cascading status set on a Space. ClickUp v2 PUT /space
	 * silently ignores `statuses` unless the full Space payload is replayed
	 * (verified empirically — same no-op pattern as PUT /folder {archived}).
	 * Always re-fetch the Space first and merge name + multiple_assignees +
	 * features into the PUT body alongside the new statuses.
	 */
	async setSpaceStatuses(
		spaceId: string,
		statuses: ClickUpStatus[],
		token: string,
	): Promise<void> {
		const space = await this.fetchV2<
			ClickUpSpace & {
				multiple_assignees?: boolean;
				features?: Record<string, unknown>;
			}
		>(`/space/${spaceId}`, token);
		await this.fetchV2(`/space/${spaceId}`, token, "PUT", {
			name: space.name,
			multiple_assignees: space.multiple_assignees ?? true,
			features: space.features ?? {},
			statuses,
		});
	}

	// ---------- folders ----------

	/**
	 * Probe a Space by id. Throws HttpException(404) when the Space has been
	 * deleted from ClickUp; throws other status codes on auth/server errors.
	 * Used by OrphanDetectionCron (Plan §B.8).
	 */
	async getSpace(
		spaceId: string,
		token: string,
	): Promise<{ id: string; name: string }> {
		return this.fetchV2<{ id: string; name: string }>(
			`/space/${spaceId}`,
			token,
		);
	}

	async listFolders(spaceId: string, token: string): Promise<ClickUpFolder[]> {
		const r = await this.fetchV2<{ folders: ClickUpFolder[] }>(
			`/space/${spaceId}/folder?archived=false`,
			token,
		);
		return r.folders;
	}

	async createFolder(
		spaceId: string,
		name: string,
		token: string,
	): Promise<ClickUpFolder> {
		return this.fetchV2<ClickUpFolder>(
			`/space/${spaceId}/folder`,
			token,
			"POST",
			{ name },
		);
	}

	async getFolder(folderId: string, token: string): Promise<ClickUpFolder> {
		return this.fetchV2<ClickUpFolder>(`/folder/${folderId}`, token);
	}

	/**
	 * NOTE: ClickUp v2 has no working folder-archive API. PUT /folder/{id}
	 * accepts only `name`; sending `archived: true` returns 200 but is a
	 * silent no-op (verified Session 1 / CARL decision -004). Use
	 * deleteFolder() when you need the folder gone.
	 */
	async deleteFolder(folderId: string, token: string): Promise<void> {
		await this.fetchV2(`/folder/${folderId}`, token, "DELETE");
	}

	// ---------- lists ----------

	async listListsInFolder(
		folderId: string,
		token: string,
	): Promise<ClickUpList[]> {
		const r = await this.fetchV2<{ lists: ClickUpList[] }>(
			`/folder/${folderId}/list?archived=false`,
			token,
		);
		return r.lists;
	}

	async createListInFolder(
		folderId: string,
		name: string,
		token: string,
	): Promise<ClickUpList> {
		return this.fetchV2<ClickUpList>(
			`/folder/${folderId}/list`,
			token,
			"POST",
			{ name },
		);
	}

	/** Replace the status set on a single List (overrides Space-level statuses). */
	async setListStatuses(
		listId: string,
		statuses: ClickUpStatus[],
		token: string,
	): Promise<void> {
		await this.fetchV2(`/list/${listId}`, token, "PUT", { statuses });
	}

	/** Move a task to a different List in the same Workspace. v3 only. */
	async moveTaskToList(
		workspaceId: string,
		taskId: string,
		targetListId: string,
		token: string,
	): Promise<void> {
		await this.fetchV3(
			`/workspaces/${workspaceId}/tasks/${taskId}/home_list/${targetListId}`,
			token,
			"PUT",
		);
	}

	// ---------- tags ----------

	async listSpaceTags(
		spaceId: string,
		token: string,
	): Promise<Array<{ name: string; tag_fg?: string; tag_bg?: string }>> {
		const r = await this.fetchV2<{
			tags: Array<{ name: string; tag_fg?: string; tag_bg?: string }>;
		}>(`/space/${spaceId}/tag`, token);
		return r.tags ?? [];
	}

	async createSpaceTag(
		spaceId: string,
		name: string,
		token: string,
		fg = "#ffffff",
		bg = "#3b82f6",
	): Promise<void> {
		await this.fetchV2(`/space/${spaceId}/tag`, token, "POST", {
			tag: { name, tag_fg: fg, tag_bg: bg },
		});
	}

	/**
	 * Attach an existing Space-level tag to a task. The tag must already
	 * exist in the Space (call createSpaceTag first if unsure). The CU
	 * v2 endpoint is POST /task/{id}/tag/{name} with no body.
	 */
	async addTagToTask(
		taskId: string,
		tagName: string,
		token: string,
	): Promise<void> {
		await this.fetchV2(
			`/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
			token,
			"POST",
			{},
		);
	}

	// ---------- tasks ----------

	async createTask(
		listId: string,
		body: CreateTaskBody,
		token: string,
	): Promise<ClickUpTask> {
		return this.fetchV2<ClickUpTask>(
			`/list/${listId}/task`,
			token,
			"POST",
			this.normaliseTaskBody(body),
		);
	}

	/** Subtask = task with `parent` set; same endpoint, same body. */
	async createSubtask(
		listId: string,
		parentTaskId: string,
		body: Omit<CreateTaskBody, "parent">,
		token: string,
	): Promise<ClickUpTask> {
		return this.createTask(listId, { ...body, parent: parentTaskId }, token);
	}

	async getTask(taskId: string, token: string): Promise<ClickUpTaskFull> {
		return this.fetchV2<ClickUpTaskFull>(
			`/task/${taskId}?include_markdown_description=true`,
			token,
		);
	}

	async listTasksInList(
		listId: string,
		token: string,
	): Promise<ClickUpTaskFull[]> {
		const r = await this.fetchV2<{ tasks: ClickUpTaskFull[] }>(
			`/list/${listId}/task?archived=false&include_closed=true&subtasks=true&include_markdown_description=true`,
			token,
		);
		return r.tasks ?? [];
	}

	async updateTask(
		taskId: string,
		patch: UpdateTaskBody,
		token: string,
	): Promise<void> {
		await this.fetchV2(
			`/task/${taskId}`,
			token,
			"PUT",
			this.normaliseTaskBody(patch),
		);
	}

	async setTaskStatus(
		taskId: string,
		status: string,
		token: string,
	): Promise<void> {
		await this.updateTask(taskId, { status }, token);
	}

	/**
	 * Archive a task (CU-soft delete; recoverable from CU UI Trash for 30
	 * days). Used by the repair-routing flow to clean up duplicates from
	 * prior wipe-and-rereg cycles. Hard-delete is intentionally NOT
	 * exposed — keeps Plan §C.0's "every autonomous action is reversible"
	 * invariant intact.
	 */
	async archiveTask(taskId: string, token: string): Promise<void> {
		await this.fetchV2(`/task/${taskId}`, token, "PUT", { archived: true });
	}

	async setTaskDates(
		taskId: string,
		startMs: number | null,
		dueMs: number | null,
		token: string,
	): Promise<void> {
		const patch: UpdateTaskBody = {};
		if (startMs !== null) patch.start_date = startMs;
		if (dueMs !== null) patch.due_date = dueMs;
		if (Object.keys(patch).length === 0) return;
		await this.updateTask(taskId, patch, token);
	}

	async setTaskPoints(
		taskId: string,
		points: number,
		token: string,
	): Promise<void> {
		await this.updateTask(taskId, { points }, token);
	}

	async setTaskTimeEstimate(
		taskId: string,
		ms: number,
		token: string,
	): Promise<void> {
		await this.updateTask(taskId, { time_estimate: ms }, token);
	}

	async assignTask(
		taskId: string,
		addUserIds: number[],
		removeUserIds: number[],
		token: string,
	): Promise<void> {
		if (addUserIds.length === 0 && removeUserIds.length === 0) return;
		await this.updateTask(
			taskId,
			{ assignees: { add: addUserIds, rem: removeUserIds } },
			token,
		);
	}

	// ---------- comments ----------

	async addComment(
		taskId: string,
		comment: string,
		token: string,
		notifyAll = false,
	): Promise<void> {
		await this.fetchV2(`/task/${taskId}/comment`, token, "POST", {
			comment_text: comment,
			notify_all: notifyAll,
		});
	}

	// ---------- custom fields ----------

	async getListCustomFields(
		listId: string,
		token: string,
	): Promise<ClickUpCustomField[]> {
		const r = await this.fetchV2<{ fields: ClickUpCustomField[] }>(
			`/list/${listId}/field`,
			token,
		);
		return r.fields ?? [];
	}

	async setCustomFieldValue(
		taskId: string,
		fieldId: string,
		value: unknown,
		token: string,
	): Promise<void> {
		await this.fetchV2(`/task/${taskId}/field/${fieldId}`, token, "POST", {
			value,
		});
	}

	async createCustomField(
		listId: string,
		body: {
			name: string;
			type:
				| "short_text"
				| "text"
				| "url"
				| "email"
				| "phone"
				| "number"
				| "currency"
				| "date"
				| "drop_down"
				| "labels"
				| "checkbox"
				| "users"
				| "task_relationship"
				| "manual_progress"
				| "automatic_progress";
			type_config?: {
				options?: Array<{ name: string; color?: string; orderindex?: number }>;
				new_drop_down?: boolean;
				default?: number;
				[k: string]: unknown;
			};
			required?: boolean;
		},
		token: string,
	): Promise<{ id: string }> {
		const r = await this.fetchV2<{ field: { id: string } } | { id: string }>(
			`/list/${listId}/field`,
			token,
			"POST",
			body,
		);
		const id =
			(r as { field?: { id: string } }).field?.id ?? (r as { id?: string }).id;
		if (!id) throw new BadGatewayException("createCustomField: missing id");
		return { id };
	}

	// ---------- checklists ----------

	async createChecklist(
		taskId: string,
		name: string,
		token: string,
	): Promise<{ id: string }> {
		const r = await this.fetchV2<{ checklist: { id: string } }>(
			`/task/${taskId}/checklist`,
			token,
			"POST",
			{ name },
		);
		return r.checklist;
	}

	async createChecklistItem(
		checklistId: string,
		name: string,
		token: string,
		assignee?: number,
	): Promise<void> {
		await this.fetchV2(
			`/checklist/${checklistId}/checklist_item`,
			token,
			"POST",
			assignee !== undefined ? { name, assignee } : { name },
		);
	}

	// ---------- time entries (backdateable) ----------

	async createTimeEntry(
		teamId: string,
		body: {
			tid: string;
			start: number;
			duration: number;
			description?: string;
			assignee?: number;
			billable?: boolean;
			tags?: Array<{ name: string }>;
		},
		token: string,
	): Promise<void> {
		await this.fetchV2(`/team/${teamId}/time_entries`, token, "POST", body);
	}

	// ---------- dependencies ----------

	async addDependency(
		taskId: string,
		body: { depends_on?: string; dependency_of?: string },
		token: string,
	): Promise<void> {
		await this.fetchV2(`/task/${taskId}/dependency`, token, "POST", body);
	}

	// ---------- members ----------

	async listMembers(teamId: string, token: string): Promise<ClickUpMember[]> {
		type TeamRow = { id: string; members: Array<{ user: ClickUpMember }> };
		const r = await this.fetchV2<{ teams: TeamRow[] }>(`/team`, token);
		const team = (r.teams ?? []).find((t) => t.id === teamId) ?? r.teams?.[0];
		return (team?.members ?? []).map((m) => m.user).filter(Boolean);
	}

	// ---------- webhooks (outbound from ClickUp) ----------

	async createWebhook(
		teamId: string,
		endpoint: string,
		events: string[],
		token: string,
		scope?: {
			space_id?: string;
			folder_id?: string;
			list_id?: string;
			task_id?: string;
		},
	): Promise<ClickUpWebhook> {
		type Resp = { id: string; webhook: { id: string; secret: string } };
		const r = await this.fetchV2<Resp>(
			`/team/${teamId}/webhook`,
			token,
			"POST",
			{ endpoint, events, ...scope },
		);
		return r.webhook ?? ({ id: r.id, secret: "" } as ClickUpWebhook);
	}

	async deleteWebhook(webhookId: string, token: string): Promise<void> {
		await this.fetchV2(`/webhook/${webhookId}`, token, "DELETE");
	}

	// ---------- views ----------

	async listListViews(listId: string, token: string): Promise<ClickUpView[]> {
		const r = await this.fetchV2<{ views: ClickUpView[] }>(
			`/list/${listId}/view`,
			token,
		);
		return r.views ?? [];
	}

	async createListView(
		listId: string,
		body: {
			name: string;
			type:
				| "list"
				| "board"
				| "calendar"
				| "table"
				| "timeline"
				| "workload"
				| "activity"
				| "map"
				| "conversation"
				| "gantt";
			grouping?: unknown;
			sorting?: unknown;
			filters?: unknown;
			columns?: unknown;
			settings?: unknown;
		},
		token: string,
	): Promise<{ id: string }> {
		const r = await this.fetchV2<{ view: { id: string } }>(
			`/list/${listId}/view`,
			token,
			"POST",
			body,
		);
		return r.view;
	}

	// ---------- docs (v3) ----------

	async createDoc(
		workspaceId: string,
		body: {
			name: string;
			parent: { id: string; type: 4 | 5 | 6 | 7 }; // 4=Space 5=Folder 6=List 7=Workspace
			visibility?: "PUBLIC" | "PRIVATE" | "WORKSPACE";
			create_page?: boolean;
		},
		token: string,
	): Promise<{ id: string }> {
		return this.fetchV3<{ id: string }>(
			`/workspaces/${workspaceId}/docs`,
			token,
			"POST",
			body,
		);
	}

	async createDocPage(
		workspaceId: string,
		docId: string,
		body: {
			name: string;
			content: string;
			sub_title?: string;
			parent_page_id?: string;
		},
		token: string,
	): Promise<{ id: string }> {
		return this.fetchV3<{ id: string }>(
			`/workspaces/${workspaceId}/docs/${docId}/pages`,
			token,
			"POST",
			body,
		);
	}

	async updateDocPage(
		workspaceId: string,
		docId: string,
		pageId: string,
		body: {
			name?: string;
			content?: string;
			sub_title?: string;
			content_edit_mode?: "replace" | "append" | "prepend";
		},
		token: string,
	): Promise<void> {
		await this.fetchV3(
			`/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
			token,
			"PUT",
			body,
		);
	}

	async listDocPages(
		workspaceId: string,
		docId: string,
		token: string,
	): Promise<
		Array<{ id: string; name: string; parent_page_id?: string | null }>
	> {
		// ClickUp v3 returns the array directly (not wrapped) — verified empirically.
		const r = await this.fetchV3<unknown>(
			`/workspaces/${workspaceId}/docs/${docId}/pages`,
			token,
		);
		if (Array.isArray(r)) {
			return r as Array<{
				id: string;
				name: string;
				parent_page_id?: string | null;
			}>;
		}
		const wrapped = r as {
			pages?: Array<{
				id: string;
				name: string;
				parent_page_id?: string | null;
			}>;
		};
		return wrapped.pages ?? [];
	}

	// ---------- internal helpers ----------

	/** Translate `markdown_description` → `markdown_content` for outbound writes. */
	private normaliseTaskBody<
		T extends { markdown_content?: string; markdown_description?: string },
	>(body: T): T {
		if (!body) return body;
		if (
			body.markdown_content === undefined &&
			body.markdown_description !== undefined
		) {
			const out = { ...body, markdown_content: body.markdown_description } as T;
			delete (out as { markdown_description?: string }).markdown_description;
			return out;
		}
		if (body.markdown_description !== undefined) {
			// Both present → prefer markdown_content; drop the legacy alias to avoid sending both.
			const out = { ...body } as T;
			delete (out as { markdown_description?: string }).markdown_description;
			return out;
		}
		return body;
	}

	private fetchV2<T = unknown>(
		path: string,
		token: string,
		method: HttpMethod = "GET",
		body?: unknown,
	): Promise<T> {
		return this.requestWithRetry<T>(
			`${V2_BASE}${path}`,
			token,
			method,
			body,
			"v2",
		);
	}

	private fetchV3<T = unknown>(
		path: string,
		token: string,
		method: HttpMethod = "GET",
		body?: unknown,
	): Promise<T> {
		return this.requestWithRetry<T>(
			`${V3_BASE}${path}`,
			token,
			method,
			body,
			"v3",
		);
	}

	private async requestWithRetry<T>(
		url: string,
		token: string,
		method: HttpMethod,
		body: unknown,
		apiVersion: "v2" | "v3",
	): Promise<T> {
		const isMutation = method !== "GET";
		const bucketKey = bucketKeyForToken(token);

		let attempt = 0;
		while (true) {
			attempt += 1;

			if (isMutation) {
				const priority = currentPriority() ?? "normal";
				const waited = await this.limiter.acquire(bucketKey, priority);
				if (waited > 200) {
					this.log.debug(
						`limiter[${priority}]: waited ${waited}ms before ${method} ${url}`,
					);
				}
			}

			let res: Response;
			try {
				res = await fetch(url, {
					method,
					headers: {
						Authorization: token,
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch (err) {
				// Network error — retry like a 5xx.
				if (attempt > MAX_5XX_RETRIES) {
					throw new BadGatewayException(
						`ClickUp ${apiVersion} ${method} ${url} network error after ${attempt - 1} retries: ${(err as Error).message}`,
					);
				}
				const backoff =
					RETRY_5XX_BACKOFF_MS[
						Math.min(attempt - 1, RETRY_5XX_BACKOFF_MS.length - 1)
					];
				await sleep(backoff);
				continue;
			}

			const text = await res.text();

			if (res.ok) {
				return text ? (JSON.parse(text) as T) : (undefined as T);
			}

			const detail = text.slice(0, 300);
			const path = url.replace(V2_BASE, "").replace(V3_BASE, "");
			const summary = `ClickUp ${apiVersion} ${method} ${path} → ${res.status}: ${detail}`;

			if (res.status === 401 || res.status === 403) {
				throw new UnauthorizedException(
					`ClickUp rejected the token (HTTP ${res.status}). Check CLICKUP_API_TOKEN. Upstream: ${detail}`,
				);
			}

			if (res.status === 429) {
				const resetHeader = res.headers.get("x-ratelimit-reset");
				const resetEpoch = resetHeader ? parseInt(resetHeader, 10) : NaN;
				if (Number.isFinite(resetEpoch)) {
					this.limiter.forceWaitUntil(bucketKey, resetEpoch);
				}
				if (attempt > MAX_5XX_RETRIES) {
					throw new HttpException(
						{ code: "CLICKUP_RATE_LIMITED", message: summary },
						HttpStatus.TOO_MANY_REQUESTS,
					);
				}
				// Sleep until reset (or at least a backoff step). Loop will refill on next iteration.
				const waitMs = Number.isFinite(resetEpoch)
					? Math.max(500, resetEpoch * 1000 - Date.now() + 200)
					: RETRY_5XX_BACKOFF_MS[
							Math.min(attempt - 1, RETRY_5XX_BACKOFF_MS.length - 1)
						];
				this.log.warn(
					`429 from ClickUp; sleeping ${waitMs}ms (attempt ${attempt}/${MAX_5XX_RETRIES})`,
				);
				await sleep(waitMs);
				continue;
			}

			if (res.status >= 500) {
				if (attempt > MAX_5XX_RETRIES) {
					throw new BadGatewayException(
						`ClickUp upstream ${res.status} after ${attempt - 1} retries: ${detail}`,
					);
				}
				const backoff =
					RETRY_5XX_BACKOFF_MS[
						Math.min(attempt - 1, RETRY_5XX_BACKOFF_MS.length - 1)
					];
				this.log.warn(
					`5xx from ClickUp (${res.status}); backing off ${backoff}ms (attempt ${attempt}/${MAX_5XX_RETRIES})`,
				);
				await sleep(backoff);
				continue;
			}

			// 4xx (other than 401/403/429) — do not retry.
			throw new HttpException(summary, res.status);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
