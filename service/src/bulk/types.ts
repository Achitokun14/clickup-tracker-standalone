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
