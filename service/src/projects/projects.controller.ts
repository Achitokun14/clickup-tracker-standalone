import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ProjectsService, ProjectRow } from './projects.service';
import { RepairService } from '../repair/repair.service';
import { RegisterProjectDto, PatchProjectDto } from './dto/register-project.dto';

/**
 * Map a `ProjectRow` to the API-facing shape (camelCase, omits hook_secret).
 * Exposes all 19 schema columns. Bug 3 (Plan §A.3): previously dropped
 * clickupDocId, sprintLists, backfillState, templateStatus, gitDefaultBranch,
 * gitRemoteHost, gitRemoteOwnerRepo, lastSeenStatusChanges.
 */
export function mapProjectRow(row: ProjectRow) {
  return {
    id: row.id,
    localPath: row.local_path,
    displayName: row.display_name,
    gitRemoteUrl: row.git_remote_url,
    scopeConfig: row.scope_config,
    clickupTeamId: row.clickup_team_id,
    clickupSpaceId: row.clickup_space_id,
    clickupFolderId: row.clickup_folder_id,
    clickupDocId: row.clickup_doc_id,
    sprintLists: row.sprint_lists ?? {},
    backfillState: row.backfill_state ?? null,
    templateStatus: row.template_status,
    gitDefaultBranch: row.git_default_branch,
    gitRemoteHost: row.git_remote_host,
    gitRemoteOwnerRepo: row.git_remote_owner_repo,
    lastSeenStatusChanges: row.last_seen_status_changes ?? [],
    listIds: row.list_ids,
    taskIndex: row.task_index,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repair: RepairService,
  ) {}

  @Get()
  list(@Req() req: any) {
    const orgId = orgIdOrThrow(req);
    return this.projects.list(orgId);
  }

  /**
   * Resolve a project by a longest-prefix match on local_path. Used by
   * Claude Code Stop / UserPromptSubmit hooks to figure out which tracked
   * project a session belongs to. Returns 404 if no match.
   */
  @Get('resolve')
  async resolve(@Req() req: any, @Query('path') path?: string) {
    const orgId = orgIdOrThrow(req);
    if (!path) return { match: null };
    const match = await this.projects.resolveByPath(orgId, path);
    return { match };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    const row = await this.projects.get(orgIdOrThrow(req), id);
    return mapProjectRow(row);
  }

  @Post()
  register(@Req() req: any, @Body() dto: RegisterProjectDto) {
    return this.projects.register(orgIdOrThrow(req), dto);
  }

  @Patch(':id')
  patch(@Req() req: any, @Param('id') id: string, @Body() dto: PatchProjectDto) {
    return this.projects.patch(orgIdOrThrow(req), id, dto);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string, @Query('wipe') wipe?: string) {
    return this.projects.remove(orgIdOrThrow(req), id, wipe === 'true');
  }

  /**
   * Plan §A.4 — clean up duplicate commit tasks from prior wipe-and-rereg
   * cycles + move misrouted In-Review tasks to the current sprint List.
   * Default `?dryRun=true`; pass `?dryRun=false` to actually mutate.
   */
  @Post(':id/repair-routing')
  async repairRouting(
    @Req() req: any,
    @Param('id') id: string,
    @Query('dryRun') dryRun?: string,
  ) {
    orgIdOrThrow(req);
    const isDry = dryRun !== 'false'; // default true
    return this.repair.repairRouting(id, isDry);
  }
}

function orgIdOrThrow(req: any): string {
  const orgId = req.user?.orgId || req.headers?.['x-organisation-id'];
  if (!orgId) throw new UnauthorizedException('missing x-organisation-id');
  return orgId;
}
