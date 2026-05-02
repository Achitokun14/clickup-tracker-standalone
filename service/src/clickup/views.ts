import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "./clickup-direct.service";
import type { ListKey as CustomFieldListKey } from "./custom-fields";

export interface ViewSpec {
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
	settings?: unknown;
	/**
	 * Set when the view requires a paid CU tier (Workload). seedViewsForList
	 * downgrades errors on these to debug logs.
	 */
	tierGated?: boolean;
}

const STD_PRIORITY_SORT = {
	fields: [{ field: "priority", dir: "asc" }],
};

/**
 * Default v0.4.0 view set per List. Idempotent — `seedViewsForList`
 * matches existing views by name (case-insensitive).
 *
 * Native CU sort/group/filter shapes are not version-pinned; the API
 * accepts a free `grouping`/`sorting` object so we ship sensible defaults
 * but the view will still render even if CU silently drops unsupported
 * sub-fields (CU rule of thumb).
 */
export const VIEWS_PER_LIST: Record<CustomFieldListKey, ViewSpec[]> = {
	active_sprint: [
		{
			name: "Board — by assignee",
			type: "board",
			grouping: { field: "assignee" },
		},
		{
			name: "Calendar",
			type: "calendar",
		},
		{
			name: "Gantt",
			type: "gantt",
		},
		{ name: "Workload", type: "workload", tierGated: true },
	],
	in_review: [
		{
			name: "Board — by status",
			type: "board",
			grouping: { field: "status" },
		},
	],
	bugs: [
		{
			name: "Board — by severity",
			type: "board",
			grouping: { field: "tag" },
		},
		{
			name: "List — sorted by severity",
			type: "list",
			sorting: STD_PRIORITY_SORT,
		},
	],
	open_work: [
		{
			name: "Board — by epic",
			type: "board",
			grouping: { field: "tag" },
		},
		{
			name: "List — sorted by priority",
			type: "list",
			sorting: STD_PRIORITY_SORT,
		},
	],
	history_overview: [],
	adrs: [],
	agent_sessions: [],
};

/**
 * Sprint history Lists get a Calendar view.
 */
export const SPRINT_LIST_VIEWS: ViewSpec[] = [
	{ name: "Calendar", type: "calendar" },
];

@Injectable()
export class ViewsService {
	private readonly log = new Logger(ViewsService.name);

	constructor(private readonly clickup: ClickUpDirectService) {}

	/**
	 * Seed every spec'd view; skip ones already present (matched on name,
	 * case-insensitive). Per-view failures are non-fatal. tierGated views
	 * that 4xx are demoted to debug log so non-Business+ workspaces don't
	 * get warning noise on every backfill.
	 */
	async seedViewsForList(
		listId: string,
		listKey: CustomFieldListKey | "sprint",
		token: string,
	): Promise<void> {
		const wanted =
			listKey === "sprint"
				? SPRINT_LIST_VIEWS
				: (VIEWS_PER_LIST[listKey] ?? []);
		if (wanted.length === 0) return;

		let existing: Array<{ name?: string }> = [];
		try {
			existing = await this.clickup.listListViews(listId, token);
		} catch (err) {
			this.log.debug(
				`listListViews(${listId}) failed: ${(err as Error).message}`,
			);
		}
		const have = new Set(
			existing
				.map((v) => (v.name ?? "").toLowerCase())
				.filter((n) => n.length > 0),
		);

		for (const v of wanted) {
			if (have.has(v.name.toLowerCase())) continue;
			try {
				await this.clickup.createListView(
					listId,
					{
						name: v.name,
						type: v.type,
						grouping: v.grouping,
						sorting: v.sorting,
						filters: v.filters,
						settings: v.settings,
					},
					token,
				);
			} catch (err) {
				const msg = (err as Error).message;
				if (v.tierGated) {
					this.log.debug(
						`createListView(${v.name}) skipped (tier-gated): ${msg}`,
					);
				} else {
					this.log.warn(`createListView(${v.name}) failed: ${msg}`);
				}
			}
		}
	}
}
