import {
	Body,
	Controller,
	HttpCode,
	Logger,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import { inboundWebhooksTotal } from "../metrics/registry";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";
import { ClickUpHmacGuard } from "./clickup-hmac.guard";

interface WebhookPayload {
	event?: string;
	webhook_id?: string;
	team_id?: string | number;
	history_items?: Array<{
		id?: string;
		type?: string;
		date?: string;
		field?: string;
		parent_id?: string;
		data?: Record<string, unknown>;
		source?: Record<string, unknown>;
		user?: Record<string, unknown>;
		before?: unknown;
		after?: unknown;
	}>;
	task_id?: string;
}

/**
 * Public webhook ingress for ClickUp → daemon. The /public/ prefix bypasses
 * the gateway's InternalAuthGuard; ClickUpHmacGuard is the only auth.
 *
 * Strategy: validate signature, persist into clickup_inbound_events with
 * dedup on (team_id, webhook_event_id, history_item_id), and enqueue a
 * cup-sync job that fans out to project state without echoing back to git.
 */
@Controller("public")
export class ClickUpWebhooksController {
	private readonly log = new Logger(ClickUpWebhooksController.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly queue: QueueService,
	) {}

	@Post("clickup-events")
	@HttpCode(200)
	@UseGuards(ClickUpHmacGuard)
	async ingest(@Req() req: any, @Body() body: WebhookPayload) {
		const teamId = String(body.team_id ?? req.cupTeam?.teamId ?? "");
		if (!teamId) return { ok: false, reason: "no_team" };

		const eventType = String(body.event ?? "unknown");
		const items = body.history_items ?? [];
		const taskId = String(body.task_id ?? "");
		const webhookEventId = String(body.webhook_id ?? `${teamId}:${Date.now()}`);

		let inserted = 0;
		const skipped: string[] = [];

		// One row per history_item so dedup is granular; if there are no items
		// (e.g. taskCreated webhooks include a top-level task_id but no items),
		// still record one row keyed by the webhook_id.
		const rows = items.length > 0 ? items : [null];
		for (const item of rows) {
			const itemId = item?.id ?? "";
			try {
				const out = await this.prisma.$queryRawUnsafe<
					Array<{ id: string }>
				>(
					`INSERT INTO clickup_tracker.clickup_inbound_events
            (clickup_team_id, webhook_event_id, history_item_id, event_type, task_id, payload)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (clickup_team_id, webhook_event_id, history_item_id) DO NOTHING
          RETURNING id`,
					teamId,
					webhookEventId,
					itemId,
					eventType,
					taskId || null,
					JSON.stringify({ event: eventType, item, top: { task_id: taskId } }),
				);
				if (out.length > 0) {
					inserted += 1;
					inboundWebhooksTotal.inc({ event_type: eventType, processed: "false" });
				} else {
					skipped.push(itemId || webhookEventId);
					inboundWebhooksTotal.inc({ event_type: eventType, processed: "deduplicated" });
				}
			} catch (err) {
				this.log.warn(
					`inbound insert failed: ${(err as Error).message}`,
				);
			}
		}

		// Lightweight side-effect: track the most recent status changes so
		// /projects/:id/backfill can surface them to humans without an extra
		// query. Best-effort — single project per task lookup; multi-project
		// teams just persist the row and let the worker resolve later.
		if (eventType === "taskStatusUpdated" && taskId) {
			await this.recordStatusChangeOnProject(teamId, taskId, body);
		}

		// Enqueue a generic sync job; the cup-sync worker re-loads from the
		// inbound table at its own pace.
		await this.queue.addJob(
			"cup-sync",
			{ kind: "clickup_inbound", teamId, webhookEventId },
			{
				jobId: `cu-inbound:${teamId}:${webhookEventId}`,
				attempts: 3,
			},
		);

		return { ok: true, inserted, deduplicated: skipped.length };
	}

	private async recordStatusChangeOnProject(
		teamId: string,
		taskId: string,
		body: WebhookPayload,
	): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET last_seen_status_changes =
            (COALESCE(last_seen_status_changes, '[]'::jsonb)
             || jsonb_build_array($3::jsonb))
            #- '{100}',
             updated_at = NOW()
         WHERE clickup_team_id = $1
           AND task_index ? ('commit:' || $2)`,
				teamId,
				taskId,
				JSON.stringify({
					at: new Date().toISOString(),
					task_id: taskId,
					event: body.event,
					items: body.history_items?.length ?? 0,
				}),
			);
		} catch (err) {
			this.log.debug(
				`recordStatusChange failed: ${(err as Error).message}`,
			);
		}
	}
}
