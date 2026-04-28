import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { ClickUpDirectService } from '../clickup/clickup-direct.service';
import { SyncService } from '../sync/sync.service';
import { eventsTotal } from '../metrics/registry';
import { parseConventional, normaliseScope } from './conventional';
import type { GitEventDto, PromptEventDto } from './dto/git-event.dto';

export interface EventReceipt {
  eventId: string;
  replayed: boolean;
  actionsCount: number;
  actions: ResultingAction[];
}

export type ResultingAction =
  | { kind: 'skipped'; reason: string }
  | { kind: 'replayed' }
  | { kind: 'create_task'; task_id: string; list_key: string; source?: string }
  | { kind: 'close_task'; task_id: string; reason?: string }
  | { kind: 'start_task'; task_id: string }
  | { kind: 'comment'; task_id: string }
  | { kind: 'conflict_skipped'; task_id: string };

interface ProjectMin {
  id: string;
  organisation_id: string;
  display_name: string;
  clickup_team_id: string;
  clickup_folder_id: string;
  list_ids: { overview: string; open_work: string; history: string };
  task_index: Record<string, string>;
}

@Injectable()
export class EventsService {
  private readonly log = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly clickup: ClickUpDirectService,
    private readonly sync: SyncService,
  ) {}

  // ── git events ─────────────────────────────────────────────

  async ingestGit(projectId: string, dto: GitEventDto, idempotencyKey?: string): Promise<EventReceipt> {
    const dedupeKey = `git:${projectId}:${dto.commit_sha}${idempotencyKey ? `:${idempotencyKey}` : ''}`;

    // 1. Idempotency
    const replayed = await this.checkAndMark(dedupeKey, 'git');
    if (replayed) {
      eventsTotal.inc({ kind: 'git', outcome: 'replayed' });
      return { eventId: '', replayed: true, actionsCount: 0, actions: [{ kind: 'replayed' }] };
    }

    // 2. Load project
    const project = await this.loadProject(projectId);
    if (!project) {
      throw new Error('project not found (post-HMAC; race condition?)');
    }

    // 3. Insert the git_events row.
    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO clickup_tracker.git_events (
        project_id, commit_sha, branch, author, committer_email,
        committed_at, message, files_changed, todo_diffs, resulting_actions
      )
      VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7, $8::jsonb, $9::jsonb, '[]'::jsonb)
      ON CONFLICT (project_id, commit_sha) DO UPDATE SET message = EXCLUDED.message
      RETURNING id`,
      project.id,
      dto.commit_sha,
      dto.branch ?? null,
      dto.author ?? null,
      dto.committer_email ?? null,
      dto.committed_at ?? null,
      dto.message,
      JSON.stringify(dto.files_changed ?? []),
      JSON.stringify(dto.todo_diffs ?? []),
    );
    const eventId = inserted[0].id;

    // 4. Parse + emit actions.
    const cc = parseConventional(dto.message);
    const actions: ResultingAction[] = [];

    if (cc.hasSkipMarker) {
      actions.push({ kind: 'skipped', reason: 'clickup-skip marker present' });
      await this.persistActions(eventId, actions);
      return { eventId, replayed: false, actionsCount: 0, actions };
    }

    let creds: Awaited<ReturnType<typeof this.credentials.forOrg>> | null = null;
    try {
      creds = await this.credentials.forOrg(project.organisation_id);
    } catch (err) {
      // No credentials → record but don't crash.
      this.log.warn(`no credentials for org ${project.organisation_id}: ${(err as Error).message}`);
      actions.push({ kind: 'skipped', reason: 'no_clickup_credentials' });
      await this.persistActions(eventId, actions);
      return { eventId, replayed: false, actionsCount: 0, actions };
    }

    // 4a. TODO diffs — adds become new tasks; removes close existing matching tasks.
    for (const diff of dto.todo_diffs ?? []) {
      const todoKey = `todo:${diff.file}:${diff.line ?? '?'}`;
      if (diff.op === 'add') {
        try {
          const task = await this.clickup.createTask(
            project.list_ids.open_work,
            {
              name: `${diff.marker}: ${truncate(diff.text, 80)}`,
              markdown_description: this.todoDescription(diff, dto.commit_sha),
            },
            creds.token,
          );
          await this.appendToTaskIndex(project.id, { [todoKey]: task.id });
          project.task_index[todoKey] = task.id;
          actions.push({
            kind: 'create_task',
            task_id: task.id,
            list_key: 'open_work',
            source: `git:${dto.commit_sha}`,
          });
        } catch (err) {
          this.log.warn(`createTask failed: ${(err as Error).message}`);
        }
      } else if (diff.op === 'remove') {
        const existing = project.task_index[todoKey];
        if (existing) {
          try {
            await this.clickup.addComment(
              existing,
              `Resolved by ${dto.commit_sha}${dto.author ? ` (${dto.author})` : ''}`,
              creds.token,
            );
            actions.push({ kind: 'close_task', task_id: existing, reason: 'todo_removed' });
          } catch (err) {
            this.log.warn(`addComment failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // 4b. Conventional Commit verb mapping.
    if (cc.type === 'fix' && cc.scope) {
      const candidate = this.findTaskByScope(project, cc.scope);
      if (candidate) {
        try {
          await this.clickup.addComment(
            candidate,
            `Fixed in ${dto.commit_sha}${dto.author ? ` by ${dto.author}` : ''}: ${cc.subject}`,
            creds.token,
          );
          actions.push({ kind: 'close_task', task_id: candidate, reason: `fix(${cc.scope})` });
        } catch (err) {
          this.log.warn(`fix-comment failed: ${(err as Error).message}`);
        }
      }
    } else if (cc.type === 'feat' && cc.scope) {
      const candidate = this.findTaskByScope(project, cc.scope);
      if (candidate) {
        try {
          await this.clickup.addComment(candidate, `In progress via ${dto.commit_sha}: ${cc.subject}`, creds.token);
          actions.push({ kind: 'start_task', task_id: candidate });
        } catch {
          // ignore
        }
      }
    }

    // 4c. Always: append commit summary to Overview & Docs.
    const overviewId = project.task_index['overview'];
    if (overviewId) {
      try {
        await this.clickup.addComment(overviewId, this.formatCommitForOverview(dto, cc, actions), creds.token);
        actions.push({ kind: 'comment', task_id: overviewId });
      } catch {
        // ignore
      }
    }

    // 5. Persist actions + mark processed.
    await this.persistActions(eventId, actions);
    await this.touchLastSync(project.id);

    eventsTotal.inc({ kind: 'git', outcome: 'processed' });
    return { eventId, replayed: false, actionsCount: actions.length, actions };
  }

  // ── prompt events ──────────────────────────────────────────

  async ingestPrompt(projectId: string, dto: PromptEventDto, idempotencyKey?: string): Promise<EventReceipt> {
    const dedupeKey = `prompt:${projectId}:${idempotencyKey ?? Date.now()}`;
    const replayed = await this.checkAndMark(dedupeKey, 'prompt');
    if (replayed) {
      eventsTotal.inc({ kind: 'prompt', outcome: 'replayed' });
      return { eventId: '', replayed: true, actionsCount: 0, actions: [{ kind: 'replayed' }] };
    }

    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO clickup_tracker.prompt_events (
        project_id, session_id, prompt_excerpt, outcome_summary, files_touched, resulting_actions
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, '[]'::jsonb)
      RETURNING id`,
      projectId,
      dto.session_id ?? null,
      truncate(dto.prompt_excerpt ?? '', 1000),
      truncate(dto.outcome_summary ?? '', 1000),
      JSON.stringify(dto.files_touched ?? []),
    );

    const eventId = inserted[0].id;

    // Fan out to ClickUp asynchronously via the cup-sync queue.
    await this.sync.enqueue({ projectId, kind: 'prompt', eventId });

    eventsTotal.inc({ kind: 'prompt', outcome: 'queued' });
    return {
      eventId,
      replayed: false,
      actionsCount: 0,
      actions: [],
    };
  }

  // ── helpers ─────────────────────────────────────────────────

  private async loadProject(projectId: string): Promise<ProjectMin | null> {
    const rows = await this.prisma.$queryRawUnsafe<ProjectMin[]>(
      `SELECT id, organisation_id, display_name, clickup_team_id, clickup_folder_id,
              list_ids::jsonb AS list_ids, task_index::jsonb AS task_index
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
      projectId,
    );
    return rows[0] ?? null;
  }

  private async checkAndMark(key: string, kind: string): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<Array<{ inserted: boolean }>>(
      `INSERT INTO clickup_tracker.processed_events (event_id, kind)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING true AS inserted`,
      key,
      kind,
    );
    // Returning empty array means conflict happened (already processed).
    return result.length === 0;
  }

  private async persistActions(eventId: string, actions: ResultingAction[]): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE clickup_tracker.git_events
       SET resulting_actions = $2::jsonb, processed_at = NOW()
       WHERE id = $1::uuid`,
      eventId,
      JSON.stringify(actions),
    );
  }

  private async appendToTaskIndex(projectId: string, additions: Record<string, string>): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE clickup_tracker.projects
       SET task_index = task_index || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      projectId,
      JSON.stringify(additions),
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

  private findTaskByScope(project: ProjectMin, scope: string): string | null {
    const target = normaliseScope(scope);
    for (const [key, taskId] of Object.entries(project.task_index)) {
      if (key === 'overview' || key === 'history') continue;
      if (normaliseScope(key).includes(target)) return taskId;
    }
    return null;
  }

  private todoDescription(diff: { file: string; line?: number; marker: string; text: string }, sha: string): string {
    return [
      `**File:** \`${diff.file}${diff.line ? `:${diff.line}` : ''}\``,
      `**Marker:** \`${diff.marker}\``,
      `**Introduced in:** ${sha.slice(0, 8)}`,
      '',
      '```',
      diff.text,
      '```',
      '',
      '_Created by clickup-tracker from a post-commit diff._',
    ].join('\n');
  }

  private formatCommitForOverview(
    dto: GitEventDto,
    cc: ReturnType<typeof parseConventional>,
    actions: ResultingAction[],
  ): string {
    const lines = [
      `### ${cc.type ?? 'commit'}${cc.scope ? `(${cc.scope})` : ''}: ${cc.subject}`,
      ``,
      `\`${dto.commit_sha.slice(0, 8)}\` by ${dto.author ?? 'unknown'} on ${dto.committed_at ?? 'now'}`,
    ];
    if (cc.body) lines.push('', cc.body);
    const counts: Record<string, number> = {};
    for (const a of actions) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    if (Object.keys(counts).length > 0) {
      lines.push(
        '',
        '_actions: ' +
          Object.entries(counts)
            .map(([k, v]) => `${k}×${v}`)
            .join(', ') +
          '_',
      );
    }
    return lines.join('\n');
  }
}

function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
