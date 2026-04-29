import {
	type CanActivate,
	type ExecutionContext,
	Injectable,
	Logger,
	UnauthorizedException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Verifies inbound webhook calls from ClickUp.
 *
 * ClickUp sends `X-Signature: <hex hmac-sha256(secret, raw_body)>` (no
 * `sha256=` prefix per their docs). The secret is returned at webhook
 * registration time (`POST /team/:id/webhook`) and stored per workspace in
 * `clickup_tracker.workspace_settings.webhook_secret`.
 *
 * Strategy mirrors GitHmacGuard: compute the expected hex digest over the
 * raw body bytes (preserved by the json parser in main.ts), then
 * timing-safe-compare. We resolve the team via the payload's `team_id`
 * field — webhooks aren't scoped per-project.
 */
@Injectable()
export class ClickUpHmacGuard implements CanActivate {
	private readonly log = new Logger(ClickUpHmacGuard.name);
	constructor(private readonly prisma: PrismaService) {}

	async canActivate(ctx: ExecutionContext): Promise<boolean> {
		const req = ctx.switchToHttp().getRequest();
		const headers = req.headers || {};
		const sig = String(headers["x-signature"] || "");
		const rawBody: Buffer | undefined = req.rawBody;
		if (!sig) throw new UnauthorizedException({ code: "MISSING_SIGNATURE" });
		if (!rawBody) throw new UnauthorizedException({ code: "MISSING_RAW_BODY" });

		// Pull team_id from the parsed payload.
		const body = req.body ?? {};
		const teamId = String(body.team_id ?? body.teamId ?? "");
		if (!teamId) throw new UnauthorizedException({ code: "MISSING_TEAM_ID" });

		const rows = await this.prisma.$queryRawUnsafe<
			Array<{ webhook_secret: string | null }>
		>(
			`SELECT webhook_secret
       FROM clickup_tracker.workspace_settings
       WHERE clickup_team_id = $1
       LIMIT 1`,
			teamId,
		);
		const secret = rows[0]?.webhook_secret;
		if (!secret) {
			throw new UnauthorizedException({ code: "UNKNOWN_TEAM_OR_NO_SECRET" });
		}

		const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
		if (sig.length !== expected.length) {
			throw new UnauthorizedException({ code: "BAD_SIGNATURE" });
		}
		const ok = timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
		if (!ok) throw new UnauthorizedException({ code: "BAD_SIGNATURE" });

		req.cupTeam = { teamId };
		return true;
	}
}
