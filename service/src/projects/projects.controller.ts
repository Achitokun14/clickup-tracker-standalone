import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { RegisterProjectDto, PatchProjectDto } from './dto/register-project.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

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
    // Return a shape that omits hook_secret; useful for openclaw/zeroclaw.
    return {
      id: row.id,
      localPath: row.local_path,
      displayName: row.display_name,
      gitRemoteUrl: row.git_remote_url,
      scopeConfig: row.scope_config,
      clickupTeamId: row.clickup_team_id,
      clickupSpaceId: row.clickup_space_id,
      clickupFolderId: row.clickup_folder_id,
      listIds: row.list_ids,
      taskIndex: row.task_index,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
}

function orgIdOrThrow(req: any): string {
  const orgId = req.user?.orgId || req.headers?.['x-organisation-id'];
  if (!orgId) throw new UnauthorizedException('missing x-organisation-id');
  return orgId;
}
