import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { syncDurationSeconds } from "../metrics/registry";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

interface SyncJobPayload {
	projectId?: string;
	kind: "prompt" | "git_drift" | "clickup_inbound";
	eventId?: string;
	/** clickup_inbound only — set by ClickUpWebhooksController.ingest. */
	teamId?: string;
	/** clickup_inbound only — webhook payload's webhook_id (dedup key). */
	webhookEventId?: string;
}

interface InboundEventRow {
	id: string;
	clickup_team_id: string;
	webhook_event_id: string;
	history_item_id: string | null;
	event_type: string;
	task_id: string | null;
	payload: Record<string, unknown>;
}

interface ProjectByTaskRow {
	id: string;
	clickup_team_id: string;
	task_index: Record<string, string>;
	last_seen_status_changes: unknown[];
}

interface ProjectSyncRow {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_folder_id: string;
	task_index: Record<string, string>;
	list_ids: Record<string, string>;
	template_status: string | null;
}

interface PromptEventRow {
	id: string;
	session_id: string | null;
	prompt_excerpt: string | null;
	outcome_summary: string | null;
	files_touched: Array<{ path: string; status?: string }>;
	created_at: Date;
}

const QUEUE_NAME = "cup-sync";

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
			: payload.kind === "clickup_inbound"
				? `${payload.kind}:${payload.teamId}:${payload.webhookEventId}`
				: `${payload.kind}:${payload.projectId}:${Date.now()}`;
		await this.queue.addJob(QUEUE_NAME, payload, { jobId, attempts: 3 });
	}

	private async handle(job: Job): Promise<void> {
		const payload = job.data as SyncJobPayload;
		const stop = syncDurationSeconds.startTimer({ kind: payload.kind });
		try {
			if (payload.kind === "prompt") {
				await this.handlePromptEvent(payload);
			} else if (payload.kind === "git_drift") {
				// The daemon runs in Docker without bind-mounts of user repos, so it
				// cannot shell out to `git log` for missed-commit replay. Real drift
				// recovery happens via the post-commit hook + bidirectional ClickUp
				// webhook. Just touch last_synced_at so the cron doesn't re-enqueue
				// this project every 5 minutes.
				if (payload.projectId) await this.touchLastSync(payload.projectId);
			} else if (payload.kind === "clickup_inbound") {
				await this.handleClickUpInbound(payload);
			}
		} finally {
			stop();
		}
	}

	// ── ClickUp inbound (Session 6) ─────────────────────────────

	private async handleClickUpInbound(payload: SyncJobPayload): Promise<void> {
		// Drain any unprocessed rows for this (team, webhook_event_id) tuple.
		// In practice the controller writes one row per history_item, so we may
		// have N rows to process per enqueue.
		const rows = await this.prisma.$queryRawUnsafe<InboundEventRow[]>(
			`SELECT id, clickup_team_id, webhook_event_id, history_item_id,
              event_type, task_id, payload
       FROM clickup_tracker.clickup_inbound_events
       WHERE clickup_team_id = $1
         AND webhook_event_id = $2
         AND processed_at IS NULL
       ORDER BY created_at ASC
       LIMIT 200`,
			payload.teamId,
			payload.webhookEventId,
		);
		if (rows.length === 0) return;

		for (const row of rows) {
			try {
				await this.processInboundRow(row);
				await this.prisma.$executeRawUnsafe(
					`UPDATE clickup_tracker.clickup_inbound_events
           SET processed_at = NOW()
           WHERE id = $1::uuid`,
					row.id,
				);
			} catch (err) {
				this.log.warn(
					`inbound ${row.id} (${row.event_type}) failed: ${(err as Error).message}`,
				);
			}
		}
	}

	private async processInboundRow(row: InboundEventRow): Promise<void> {
		// Resolve project via reverse task_index lookup. ClickUp task ids are
		// unique per workspace; we filter by team_id to scope the scan.
		if (!row.task_id) return;
		const projects = await this.prisma.$queryRawUnsafe<ProjectByTaskRow[]>(
			`SELECT id, clickup_team_id, task_index, last_seen_status_changes
       FROM clickup_tracker.projects
       WHERE clickup_team_id = $1
         AND status <> 'removed'`,
			row.clickup_team_id,
		);
		const owning = projects.find((p) => {
			for (const id of Object.values(p.task_index ?? {})) {
				if (id === row.task_id) return true;
			}
			return false;
		});
		if (!owning) {
			this.log.debug(
				`inbound ${row.event_type} task=${row.task_id} — no owning project in team ${row.clickup_team_id}`,
			);
			return;
		}

		// Record into the rolling last_seen_status_changes log. Bound to 100
		// entries (`#- '{100}'` removes index 100 once length exceeds it).
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
         SET last_seen_status_changes =
            (COALESCE(last_seen_status_changes, '[]'::jsonb)
              || jsonb_build_array($2::jsonb))
            #- '{100}',
             updated_at = NOW()
       WHERE id = $1::uuid`,
			owning.id,
			JSON.stringify({
				at: new Date().toISOString(),
				task_id: row.task_id,
				event: row.event_type,
				history_item_id: row.history_item_id,
			}),
		);
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
			this.log.warn(
				`no clickup credentials for org ${project.organisation_id}: ${(err as Error).message}`,
			);
			await this.recordActions(event.id, [
				{ kind: "skipped", reason: "no_credentials" },
			]);
			return;
		}

		const actions: Array<{ kind: string; task_id?: string; reason?: string }> =
			[];

		// Per-repo Space model: one task per session_id in the Agent Sessions
		// List, comments per turn. Falls back to the legacy "overview" task
		// only when neither agent_sessions list nor session_id is available.
		const sessionId = event.session_id;
		const agentSessionsListId = project.list_ids?.["agent_sessions"];
		let sessionTaskId: string | undefined;

		if (sessionId && agentSessionsListId) {
			const indexKey = `session:${sessionId}`;
			sessionTaskId = project.task_index?.[indexKey];
			if (!sessionTaskId) {
				try {
					const created = await this.clickup.createTask(
						agentSessionsListId,
						{
							name: `[${(
								event.created_at instanceof Date
									? event.created_at.toISOString()
									: String(event.created_at)
							).slice(0, 10)}] Agent session ${sessionId.slice(0, 8)}`,
							markdown_content: `Agent prompt session.\n\nSession id: \`${sessionId}\``,
							status:
								project.template_status === "configured" ? "Backlog" : "to do",
							tags: ["agent", "source:human"],
							notify_all: false,
						},
						creds.token,
					);
					sessionTaskId = created.id;
					await this.appendTaskIndex(project.id, indexKey, sessionTaskId);
					actions.push({ kind: "create_task", task_id: sessionTaskId });
				} catch (err) {
					this.log.warn(
						`createTask (agent session) failed: ${(err as Error).message}`,
					);
					actions.push({ kind: "skipped", reason: "create_task_failed" });
				}
			}
		}

		if (sessionTaskId && event.outcome_summary) {
			try {
				await this.clickup.addComment(
					sessionTaskId,
					this.formatPromptComment(event),
					creds.token,
				);
				actions.push({ kind: "comment", task_id: sessionTaskId });
			} catch (err) {
				this.log.warn(
					`addComment session task failed: ${(err as Error).message}`,
				);
				actions.push({ kind: "skipped", reason: "comment_failed" });
			}
		}

		if (actions.length === 0) {
			actions.push({ kind: "skipped", reason: "no_session_target" });
		}

		await this.recordActions(event.id, actions);
		await this.touchLastSync(project.id);
	}

	private async appendTaskIndex(
		projectId: string,
		key: string,
		value: string,
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET task_index = COALESCE(task_index, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
           updated_at = NOW()
       WHERE id = $1::uuid`,
			projectId,
			key,
			value,
		);
	}

	private async loadProject(projectId: string): Promise<ProjectSyncRow | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectSyncRow[]>(
			`SELECT id, organisation_id, display_name, clickup_folder_id,
              task_index::jsonb AS task_index,
              list_ids::jsonb AS list_ids,
              template_status
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async loadPromptEvent(
		eventId: string,
	): Promise<PromptEventRow | null> {
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
		const lines: string[] = ["### prompt outcome"];
		if (event.session_id) lines.push(`_session_ \`${event.session_id}\``);
		lines.push("", event.outcome_summary ?? "_(no summary)_");
		if (event.files_touched && event.files_touched.length > 0) {
			lines.push("", "**Files touched:**");
			for (const f of event.files_touched.slice(0, 20)) {
				lines.push(`- \`${f.path}\`${f.status ? ` _${f.status}_` : ""}`);
			}
			if (event.files_touched.length > 20) {
				lines.push(`- _…and ${event.files_touched.length - 20} more_`);
			}
		}
		return lines.join("\n");
	}
}
