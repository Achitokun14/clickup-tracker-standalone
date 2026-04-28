import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

interface ProjectDriftRow {
  id: string;
  display_name: string;
  last_synced_at: Date | null;
}

const STALE_MINUTES = parseInt(process.env.CUP_TRACKER_DRIFT_MINUTES || '60', 10);

/**
 * Periodically nudges projects that haven't synced in a while. Acts as the
 * safety net for missed webhooks (laptop offline, post-commit failed silently,
 * Redis was down). Lightweight: enqueues a `git_drift` sync job per stale
 * project; the real work happens in SyncService.handle().
 */
@Injectable()
export class DriftCron {
  private readonly log = new Logger(DriftCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    let projects: ProjectDriftRow[];
    try {
      projects = await this.prisma.$queryRawUnsafe<ProjectDriftRow[]>(
        `SELECT id, display_name, last_synced_at
         FROM clickup_tracker.projects
         WHERE status = 'active'
           AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '${STALE_MINUTES} minutes')
         ORDER BY last_synced_at ASC NULLS FIRST
         LIMIT 50`,
      );
    } catch (err) {
      this.log.warn(`drift query failed: ${(err as Error).message}`);
      return;
    }

    if (projects.length === 0) return;
    this.log.log(`drift tick: ${projects.length} stale project(s)`);

    for (const p of projects) {
      try {
        await this.sync.enqueue({ projectId: p.id, kind: 'git_drift' });
      } catch (err) {
        this.log.warn(`drift enqueue ${p.id} failed: ${(err as Error).message}`);
      }
    }
  }
}
