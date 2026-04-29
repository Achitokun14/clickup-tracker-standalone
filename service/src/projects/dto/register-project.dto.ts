import {
	IsArray,
	IsBoolean,
	IsObject,
	IsOptional,
	IsString,
	MaxLength,
} from "class-validator";
import type { RepoEntry, RepoExtract } from "../../bulk/types";

export class RegisterProjectDto {
	@IsString()
	@MaxLength(1024)
	localPath!: string;

	@IsOptional()
	@IsString()
	@MaxLength(255)
	displayName?: string;

	@IsOptional()
	@IsString()
	@MaxLength(255)
	spaceName?: string;

	@IsOptional()
	@IsString()
	gitRemoteUrl?: string;

	@IsOptional()
	@IsString()
	scopeMode?: "root" | "services" | "custom";

	@IsOptional()
	@IsObject()
	repoEntry?: RepoEntry;

	@IsOptional()
	@IsObject()
	extract?: RepoExtract;

	@IsOptional()
	@IsBoolean()
	dryRun?: boolean;

	@IsOptional()
	@IsArray()
	scopePaths?: string[];

	/**
	 * 'legacy' (default) creates the 3-list flat Folder via planRepo synchronously.
	 * 'space' creates an empty project row with backfill_state=queued, enqueues a
	 * cup-backfill job, and returns immediately. The orchestrator builds the full
	 * per-repo Space (folders, sprint Lists, Doc, views, tasks) asynchronously.
	 */
	@IsOptional()
	@IsString()
	backfillMode?: "legacy" | "space";
}

export class PatchProjectDto {
	@IsOptional()
	@IsString()
	@MaxLength(255)
	displayName?: string;

	@IsOptional()
	@IsString()
	status?: "active" | "paused" | "removed";
}
