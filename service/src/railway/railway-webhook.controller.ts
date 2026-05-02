import { createHmac, timingSafeEqual } from "node:crypto";
import {
	BadRequestException,
	Body,
	Controller,
	Headers,
	HttpCode,
	Logger,
	Param,
	Post,
	UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DeploymentMirrorService } from "./deployment-mirror.service";
import type { RailwayDeployment } from "./railway.service";
import { terminalStatus } from "./railway.service";

/**
 * Plan §N.8 — optional Railway webhook for instant deployment status
 * updates instead of the 2-min poll.
 *
 *   POST /railway/webhooks/:projectId
 *
 * Railway's public webhook surface is intentionally minimal — operators
 * may wire this from a small relay (Railway-side function or external
 * GraphQL listener) that re-shapes events into our minimal schema:
 *
 *   {
 *     "deployment": {
 *        "id": "...", "status": "SUCCESS", "serviceId": "...",
 *        "environmentName": "production",
 *        "commitSha": "abc1234", "createdAt": "...", "finishedAt": "..."
 *     }
 *   }
 *
 * If `RAILWAY_WEBHOOK_SECRET` is set in env, the request must include
 * `X-Railway-Signature: sha256=<hmac>` over the raw body. With no secret
 * configured the endpoint is open (operator-controlled cluster only).
 *
 * Falls back gracefully — RailwayPollCron continues to back-fill on its
 * 2-min cadence, so a missed webhook is just a delayed update, not lost
 * data.
 */
@Controller("railway/webhooks")
export class RailwayWebhookController {
	private readonly log = new Logger(RailwayWebhookController.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly mirror: DeploymentMirrorService,
	) {}

	@Post(":projectId")
	@HttpCode(204)
	async ingest(
		@Param("projectId") projectId: string,
		@Headers("x-railway-signature") signature: string | undefined,
		@Body() body: any,
	): Promise<void> {
		if (!body || typeof body !== "object") {
			throw new BadRequestException("missing body");
		}

		const secret = process.env.RAILWAY_WEBHOOK_SECRET;
		if (secret) {
			const raw = JSON.stringify(body);
			const expected =
				"sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
			if (!signature || !safeEqual(expected, signature)) {
				throw new UnauthorizedException("HMAC mismatch");
			}
		}

		const exists = await this.projectExists(projectId);
		if (!exists) throw new UnauthorizedException("project not found");

		const dep = parseRailwayWebhook(body);
		if (!dep) {
			// Unknown shape — accept silently so an upstream relay schema
			// change never blocks the queue.
			return;
		}
		try {
			await this.mirror.mirror(projectId, dep);
		} catch (err) {
			this.log.debug(
				`mirror(${dep.id}) from webhook failed: ${(err as Error).message}`,
			);
		}
	}

	private async projectExists(projectId: string): Promise<boolean> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
				`SELECT id FROM clickup_tracker.projects WHERE id = $1::uuid`,
				projectId,
			);
			return rows.length > 0;
		} catch {
			return false;
		}
	}
}

export function parseRailwayWebhook(body: any): RailwayDeployment | null {
	const d = body?.deployment ?? body;
	if (!d || typeof d !== "object") return null;
	if (typeof d.id !== "string" || typeof d.status !== "string") return null;
	const finished = d.finishedAt ?? (terminalStatus(d.status) ? d.updatedAt : null);
	return {
		id: d.id,
		status: d.status,
		commitSha: d.commitSha ?? d.commit_sha ?? null,
		environmentId: d.environmentId ?? null,
		environmentName: d.environmentName ?? d.environment ?? null,
		serviceId: d.serviceId ?? d.service_id ?? "",
		createdAt: d.createdAt ?? d.created_at ?? null,
		finishedAt: finished ?? null,
		staticUrl: d.staticUrl ?? d.url ?? null,
	};
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}
