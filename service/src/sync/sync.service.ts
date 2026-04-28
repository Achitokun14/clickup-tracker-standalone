import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ClickUpDirectService } from '../clickup/clickup-direct.service';
import { CredentialsService } from '../credentials/credentials.service';
import { syncDurationSeconds } from '../metrics/registry';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

interface SyncJobPayload {
  projectId: string;
  kind: 'prompt' | 'git_drift';
  eventId?: string;
}

interface ProjectSyncRow {
  id: string;
  organisation_id: string;
  display_name: string;
  clickup_folder_id: string;
  task_index: Record<string, string>;
}

interface PromptEventRow {
  id: string;
  session_id: string | null;
  prompt_excerpt: string | null;
  outcome_summary: string | null;
  files_touched: Array<{ path: string; status?: string }>;
  created_at: Date;
}

const QUEUE_NAME = 'cup-sync';

/**
 * Worker that fans prompt-events out to ClickUp deltas. Commit 5 wires this in;
 * later commits extend it (drift cron, backup snapshots, etc).
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly clickup: ClickUpDirectService,
  ) {}

  onModuleInit(): void {
    this.queue.registerQueue(QUEUE_NAME, (job) => this.handle(job));
  }

  /** Enqueue a sync job. Idempotent on jobId so duplicate enqueues collapse. */
  async enqueue(payload: SyncJobPayload): Promise<void> {
    const jobId = payload.eventId
      ? `${payload.kind}:${payload.eventId}`
      : `${payload.kind}:${payload.projectId}:${Date.now()}`;
    await this.queue.addJob(QUEUE_NAME, payload, { jobId, attempts: 3 });
  }

  private async handle(job: Job): Promise<void> {
    const payload = job.data as SyncJobPayload;
    const stop = syncDurationSeconds.startTimer({ kind: payload.kind });
    try {
      if (payload.kind === 'prompt') {
        await this.handlePromptEvent(payload);
      } else if (payload.kind === 'git_drift') {
        // Reserved for commit 7 (periodic drift cron).
        this.log.debug(`git_drift sync stub for project ${payload.projectId}`);
      }
    } finally {
      stop();
    }
  }

  private async handlePromptEvent(payload: SyncJobPayload): Promise<void> {
    if (!payload.eventId) return;

    const project = await this.loadProject(payload.projectId);
    if (!project) {
      this.log.debug(`project ${payload.projectId} gone; skipping prompt sync`);
      return;
    }

    const event = await this.loadPromptEvent(payload.eventId);
    if (!event) return;

    let creds: Awaited<ReturnType<typeof this.credentials.forOrg>>;
    try {
      creds = await this.credentials.forOrg(project.organisation_id);
    } catch (err) {
      this.log.warn(`no clickup credentials for org ${project.organisation_id}: ${(err as Error).message}`);
      await this.recordActions(event.id, [{ kind: 'skipped', reason: 'no_credentials' }]);
      return;
    }

    const overviewId = project.task_index['overview'];
    const actions: Array<{ kind: string; task_id?: string; reason?: string }> = [];

    if (overviewId && event.outcome_summary) {
      try {
        await this.clickup.addComment(overviewId, this.formatPromptComment(event), creds.token);
        actions.push({ kind: 'comment', task_id: overviewId });
      } catch (err) {
        this.log.warn(`addComment overview failed: ${(err as Error).message}`);
        actions.push({ kind: 'skipped', reason: 'comment_failed' });
      }
    } else {
      actions.push({ kind: 'skipped', reason: 'no_overview_task' });
    }

    await this.recordActions(event.id, actions);
    await this.touchLastSync(project.id);
  }

  private async loadProject(projectId: string): Promise<ProjectSyncRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<ProjectSyncRow[]>(
      `SELECT id, organisation_id, display_name, clickup_folder_id,
              task_index::jsonb AS task_index
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
      projectId,
    );
    return rows[0] ?? null;
  }

  private async loadPromptEvent(eventId: string): Promise<PromptEventRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<PromptEventRow[]>(
      `SELECT id, session_id, prompt_excerpt, outcome_summary,
              files_touched::jsonb AS files_touched, created_at
       FROM clickup_tracker.prompt_events
       WHERE id = $1::uuid`,
      eventId,
    );
    return rows[0] ?? null;
  }

  private async recordActions(
    eventId: string,
    actions: Array<{ kind: string; task_id?: string; reason?: string }>,
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE clickup_tracker.prompt_events
       SET resulting_actions = $2::jsonb
       WHERE id = $1::uuid`,
      eventId,
      JSON.stringify(actions),
    );
  }

  private async touchLastSync(projectId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE clickup_tracker.projects
       SET last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid`,
      projectId,
    );
  }

  private formatPromptComment(event: PromptEventRow): string {
    const lines: string[] = ['### prompt outcome'];
    if (event.session_id) lines.push(`_session_ \`${event.session_id}\``);
    lines.push('', event.outcome_summary ?? '_(no summary)_');
    if (event.files_touched && event.files_touched.length > 0) {
      lines.push('', '**Files touched:**');
      for (const f of event.files_touched.slice(0, 20)) {
        lines.push(`- \`${f.path}\`${f.status ? ` _${f.status}_` : ''}`);
      }
      if (event.files_touched.length > 20) {
        lines.push(`- _…and ${event.files_touched.length - 20} more_`);
      }
    }
    return lines.join('\n');
  }
}
