// Shared types between the local CLI/git-hook (which extracts data from
// disk) and the daemon (which receives the structured data over HTTP).
// Trimmed to what's needed server-side.

export type Stack =
	| "Node"
	| "Go"
	| "Python"
	| "Rust"
	| "TS"
	| "Java"
	| "PHP"
	| "Mixed"
	| "Unknown";

export type ListKey = "overview" | "open_work" | "history";

export interface RepoEntry {
	path: string;
	name: string;
	displayName: string;
	category?: string;
	stack: Stack;
	hasReadme: boolean;
	hasChangelog: boolean;
	stateFiles: string[];
	isBackup: boolean;
	excluded: boolean;
	excludedReason?: string;
	// Optional metadata enriched by the CLI before POSTing.
	gitRemoteUrl?: string;
	deployUrl?: string;
	port?: number;
}

export interface ReadmeSummary {
	title: string | null;
	excerpt: string;
}

export interface ChangelogEntry {
	heading: string;
	body: string;
}

export interface StateEntry {
	source: string;
	bucket: string;
	index: number;
	preview: string;
	raw: unknown;
}

export interface TodoMatch {
	file: string;
	line: number;
	marker: string;
	text: string;
}

export interface PackageMeta {
	name?: string;
	version?: string;
	description?: string;
	scripts?: string[];
}

export interface RepoExtract {
	readme: ReadmeSummary | null;
	changelogEntries: ChangelogEntry[];
	stateEntries: StateEntry[];
	todos: TodoMatch[];
	todosOverflow: number;
	lastCommitISO: string | null;
	pkgMeta: PackageMeta | null;
}

export interface PlannedTask {
	key: string; // stable id used for idempotent updates
	list: ListKey;
	name: string;
	markdown_content: string; // sent on the wire as ClickUp's `markdown_content` (not the deprecated `markdown_description`)
	comments?: string[]; // posted as task comments after task creation
	custom_fields?: Record<string, unknown>; // by field name; resolved to ids in the worker
}

export interface RepoPlan {
	repo: RepoEntry;
	folderName: string;
	lists: Record<ListKey, string>;
	tasks: PlannedTask[];
}

// ────────────────────────────────────────────────────────────────────
// Per-repo Space model (Session 3 — consumed by the backfill
// orchestrator in Session 4 and the bidirectional webhook in Session 5).
// Pure data; no I/O. The planner returns a SpacePlan; the orchestrator
// translates that into ClickUpDirectService calls.
// ────────────────────────────────────────────────────────────────────

export type CuPriority = 1 | 2 | 3 | 4; // 1=Urgent, 2=High, 3=Normal, 4=Low

export interface StatusDef {
	status: string;
	color?: string;
	type?: "open" | "custom" | "closed" | "done";
	orderindex?: number;
}

export interface ViewDef {
	listKey: string;
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
}

export interface SpaceFolderPlan {
	name: string;
	emoji?: string;
	lists: Array<{
		key: string; // stable id used internally + as task_index sub-key
		name: string;
		statusOverrides?: StatusDef[];
	}>;
}

export interface DocPagePlan {
	name: string;
	markdown: string;
	subTitle?: string;
}

export interface PlannedSpaceTask {
	key: string; // task_index key, e.g. "commit:<sha>" / "bug:..." / "adr:slug"
	listKey: string; // resolves to a ClickUp list_id at apply-time
	name: string; // [YYYY-MM-DD] <type>(<scope>): <subject>
	markdown_content: string;
	status: string;
	priority?: CuPriority;
	tags: string[];
	startDateMs?: number; // author date
	dueDateMs?: number; // commit date
	points?: number;
	timeEstimateMs?: number;
	assigneeEmails?: string[];
	parentKey?: string; // for subtasks (file-level)
	comments?: string[];
	customFieldValues?: Array<{ name: string; value: unknown }>; // Phase 2 only
}

export interface SpacePlan {
	spaceName: string;
	multipleAssignees: boolean;
	features: Record<string, unknown>;
	statuses: StatusDef[]; // Space-level cascade
	bugStatuses: StatusDef[]; // Bugs List override
	folders: SpaceFolderPlan[];
	tags: string[]; // pre-created on the Space before any tasks land
	doc: { name: string; pages: DocPagePlan[] };
	views: ViewDef[];
	tasks: PlannedSpaceTask[];
	templateStatus: "configured" | "inline-fallback" | "pending";
}
