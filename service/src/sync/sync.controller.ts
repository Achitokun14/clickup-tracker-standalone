import { Controller, Param, Post } from '@nestjs/common';
import { SyncService } from './sync.service';

/**
 * Manual sync trigger. The 5-minute DriftCron handles steady-state drift on
 * its own; this endpoint exists so /clickup-sync can nudge a project
 * immediately without waiting for the next cron tick.
 */
@Controller('projects/:id')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('sync')
  async syncNow(@Param('id') projectId: string) {
    await this.sync.enqueue({ projectId, kind: 'git_drift' });
    return { ok: true, queued: true, kind: 'git_drift' };
  }
}
