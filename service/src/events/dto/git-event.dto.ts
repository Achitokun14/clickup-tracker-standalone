import {
	IsArray,
	IsBoolean,
	IsOptional,
	IsString,
	IsObject,
} from "class-validator";

export class GitFileChangeDto {
	@IsString()
	path!: string;

	@IsOptional()
	@IsString()
	status?: "added" | "modified" | "deleted" | "renamed";

	@IsOptional()
	additions?: number;

	@IsOptional()
	deletions?: number;

	/**
	 * Plan §C.3 — when status='renamed', the source path before the
	 * rename. Emitted by `git diff-tree -M --name-status -r` (R lines).
	 * Forward-compatible: older hooks don't send this; new lifecycle
	 * code only fires when present.
	 */
	@IsOptional()
	@IsString()
	prev_path?: string;
}

export class TodoDiffDto {
	@IsString()
	file!: string;

	@IsString()
	op!: "add" | "remove";

	@IsString()
	marker!: string;

	@IsString()
	text!: string;

	@IsOptional()
	line?: number;
}

export class GitEventDto {
	@IsString()
	commit_sha!: string;

	@IsOptional()
	@IsString()
	branch?: string;

	@IsOptional()
	@IsString()
	author?: string;

	@IsOptional()
	@IsString()
	committer_email?: string;

	@IsOptional()
	@IsString()
	committed_at?: string; // ISO-8601

	@IsString()
	message!: string;

	@IsArray()
	files_changed!: GitFileChangeDto[];

	@IsOptional()
	@IsArray()
	todo_diffs?: TodoDiffDto[];

	@IsOptional()
	@IsString()
	remote_url?: string;

	/**
	 * Plan §C.3 — true when the hook is reporting a deleted branch
	 * (post-receive style or local pre-push --delete). When set, the
	 * lifecycle closes any In Review tasks tagged with this branch
	 * rather than creating a new commit task.
	 */
	@IsOptional()
	@IsBoolean()
	branch_deleted?: boolean;
}

export class PromptEventDto {
	@IsOptional()
	@IsString()
	session_id?: string;

	@IsOptional()
	@IsString()
	prompt_excerpt?: string;

	@IsOptional()
	@IsString()
	outcome_summary?: string;

	@IsOptional()
	@IsArray()
	files_touched?: string[];

	@IsOptional()
	@IsObject()
	metadata?: Record<string, unknown>;
}
