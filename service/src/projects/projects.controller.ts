import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ProjectsService, ProjectRow } from './projects.service';
import { RepairService } from '../repair/repair.service';
import { LookupService } from './lookup.service';
import { AdoptService, AdoptDto } from './adopt.service';
import { ContributorService } from '../scrum/contributor.service';
import { OwnershipService } from '../scrum/ownership.service';
import { QualityService } from '../scrum/quality.service';
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
    private readonly lookupSvc: LookupService,
    private readonly adoptSvc: AdoptService,
    private readonly contributors: ContributorService,
    private readonly ownership: OwnershipService,
    private readonly quality: QualityService,
  ) {}

  /**
   * Plan §B.2 — explicit adoption of an existing ClickUp Space. Hydrates
   * list_ids / sprint_lists / task_index from the Space's contents so
   * the daemon never re-creates tasks that already exist there. Manual
   * tasks (those without the auto-imported footer) are left untouched.
   */
  @Post('adopt')
  async adopt(@Req() req: any, @Body() dto: AdoptDto) {
    const orgId = orgIdOrThrow(req);
    return this.adoptSvc.adopt(orgId, dto);
  }

  @Get()
  list(@Req() req: any) {
    const orgId = orgIdOrThrow(req);
    return this.projects.list(orgId);
  }

  /**
   * Plan §B.1 — read-only candidate-Space lookup powering the
   * "/clickup-add" detect-and-prompt flow. Returns matches ranked by
   * strength so the agent can offer adopt-vs-create. `?scanFooters=true`
   * enables the more expensive remote-URL footer scan; the default
   * (shallow) is a single listSpaces() call. Result cached 60s per
   * (orgId, displayName, gitRemoteUrl).
   */
  @Get('lookup')
  async lookup(
    @Req() req: any,
    @Query('displayName') displayName?: string,
    @Query('gitRemoteUrl') gitRemoteUrl?: string,
    @Query('scanFooters') scanFooters?: string,
  ) {
    const orgId = orgIdOrThrow(req);
    if (!displayName) return { matches: [] };
    const matches = await this.lookupSvc.lookup({
      orgId,
      displayName,
      gitRemoteUrl: gitRemoteUrl ?? null,
      scanFooters: scanFooters === 'true',
    });
    return { matches };
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

  /**
   * Plan §F.4 — per-author contribution stats joined with cached GitHub
   * identities (Phase F.1). Powers the Contributors Doc page (Phase G.3)
   * and the `clickup_get_contributors` MCP tool.
   */
  @Get(':id/contributors')
  async listContributors(@Req() req: any, @Param('id') id: string) {
    // Verify project belongs to caller's org first.
    await this.projects.get(orgIdOrThrow(req), id);
    return this.contributors.listForProject(id);
  }

  /**
   * Plan §I.4-I.5 — file ownership (recency-weighted line deltas).
   *
   *   GET /projects/:id/ownership                     — top-3 owners per
   *                                                     file across the
   *                                                     project (capped 200)
   *   GET /projects/:id/ownership?path=service/src/x  — top-3 owners for
   *                                                     a single path
   */
  @Get(':id/ownership')
  async ownershipForProject(
    @Req() req: any,
    @Param('id') id: string,
    @Query('path') path?: string,
    @Query('limit') limit?: string,
  ) {
    await this.projects.get(orgIdOrThrow(req), id);
    if (path) {
      return this.ownership.topOwnersForPath(id, path, Number(limit) || 3);
    }
    const map = await this.ownership.topOwnersForProject(id, {
      topN: Number(limit) || 3,
    });
    // JSON-friendly: serialise the Map as an array of {path, owners}.
    return [...map.entries()].map(([p, owners]) => ({ path: p, owners }));
  }

  /**
   * Plan §L.3 — per-file risk scores. Computed on demand from git_events
   * (no separate materialised view yet — cheap enough for ad-hoc + nightly
   * groomer runs).
   */
  @Get(':id/risk')
  async riskForProject(
    @Req() req: any,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    await this.projects.get(orgIdOrThrow(req), id);
    return this.quality.computeRiskScores(id, {
      topN: Number(limit) || 50,
    });
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

  /**
   * Plan §B.6 — flip a project from `auth-needed` back to `active`
   * after operator rotates env credentials. The 401 detection path
   * (in EventsService etc) sets `auth-needed`; this endpoint clears it.
   *
   * Idempotent: returns `flipped: false` with the current status when
   * the project isn't in `auth-needed`.
   */
  @Post(':id/refresh-credentials')
  async refreshCredentials(@Req() req: any, @Param('id') id: string) {
    return this.projects.clearAuthNeeded(orgIdOrThrow(req), id);
  }
}

function orgIdOrThrow(req: any): string {
  const orgId = req.user?.orgId || req.headers?.['x-organisation-id'];
  if (!orgId) throw new UnauthorizedException('missing x-organisation-id');
  return orgId;
}
