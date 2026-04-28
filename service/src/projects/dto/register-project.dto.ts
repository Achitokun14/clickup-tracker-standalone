import { IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { RepoEntry, RepoExtract } from '../../bulk/types';

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
  scopeMode?: 'root' | 'services' | 'custom';

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
}

export class PatchProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @IsOptional()
  @IsString()
  status?: 'active' | 'paused' | 'removed';
}
