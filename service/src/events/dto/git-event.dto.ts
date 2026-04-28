import { IsArray, IsOptional, IsString, IsObject } from 'class-validator';

export class GitFileChangeDto {
  @IsString()
  path!: string;

  @IsOptional()
  @IsString()
  status?: 'added' | 'modified' | 'deleted' | 'renamed';

  @IsOptional()
  additions?: number;

  @IsOptional()
  deletions?: number;
}

export class TodoDiffDto {
  @IsString()
  file!: string;

  @IsString()
  op!: 'add' | 'remove';

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
