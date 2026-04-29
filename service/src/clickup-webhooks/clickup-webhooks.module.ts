import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpHmacGuard } from "./clickup-hmac.guard";
import { ClickUpWebhooksController } from "./clickup-webhooks.controller";

/**
 * Bidirectional webhook ingress: ClickUp UI edits (status changes, comments,
 * assignee/tag updates) flow back into the daemon. Persists to
 * `clickup_inbound_events` for replay and bumps a project-side rolling log
 * of recent status changes.
 *
 * For localhost-only setups, register the webhook but expose the daemon via
 * a tunnel (Cloudflare Tunnel / ngrok / Tailscale Funnel). The endpoint is
 * registered, so once a tunnel exists the dataflow Just Works.
 */
@Module({
	controllers: [ClickUpWebhooksController],
	providers: [PrismaService, ClickUpHmacGuard],
})
export class ClickUpWebhooksModule {}
