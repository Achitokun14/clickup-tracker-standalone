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
import { ReviewEventsService } from "../scrum/review-events.service";

/**
 * Plan §M.1 — GitHub webhook ingestion.
 *
 *   POST /github/webhooks/:projectId
 *
 * HMAC-verified with the secret stored on projects.github_webhook_secret
 * (X-Hub-Signature-256). Each delivery is deduped via the
 * github_webhook_events.delivery_id PK.
 *
 * Events processed in this PR:
 *   - pull_request_review.submitted → ReviewEventsService.record (Phase I.1)
 *
 * Future (PR-15): pull_request.opened/closed/merged, issues.opened/closed,
 * release.published, workflow_run.completed (Actions mirror).
 *
 * Per Plan §M risk-mitigation: NEVER log req.body for /github/webhooks/*;
 * always redact X-Hub-Signature-256 from logs.
 */
@Controller("github/webhooks")
export class GithubWebhookController {
	private readonly log = new Logger(GithubWebhookController.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly reviewEvents: ReviewEventsService,
	) {}

	@Post(":projectId")
	@HttpCode(204)
	async ingest(
		@Param("projectId") projectId: string,
		@Headers("x-hub-signature-256") signature: string | undefined,
		@Headers("x-github-event") eventType: string | undefined,
		@Headers("x-github-delivery") deliveryId: string | undefined,
		@Body() body: any,
	): Promise<void> {
		if (!eventType || !deliveryId) {
			throw new BadRequestException("missing GitHub headers");
		}

		const project = await this.loadProject(projectId);
		if (!project) throw new UnauthorizedException("project not found");
		if (!project.github_webhook_secret) {
			throw new UnauthorizedException(
				"project has no github_webhook_secret configured",
			);
		}

		// HMAC verify. The body is the *raw* JSON GitHub sent — we re-stringify
		// here as Nest has already parsed it. For strict signature parity the
		// caller can wire a raw-body middleware later; for now this matches
		// most real-world deployments since GitHub doesn't reformat its JSON.
		const raw = JSON.stringify(body);
		const expected =
			"sha256=" +
			createHmac("sha256", project.github_webhook_secret)
				.update(raw)
				.digest("hex");
		if (!signature || !safeEqual(expected, signature)) {
			throw new UnauthorizedException("HMAC mismatch");
		}

		// Idempotency on delivery_id.
		const inserted = await this.prisma
			.$executeRawUnsafe(
				`INSERT INTO clickup_tracker.github_webhook_events
				   (delivery_id, project_id, event_type, raw)
				 VALUES ($1, $2::uuid, $3, $4::jsonb)
				 ON CONFLICT (delivery_id) DO NOTHING`,
				deliveryId,
				projectId,
				eventType,
				raw,
			)
			.catch(() => 0);
		if (!inserted) {
			// Already seen — nothing more to do.
			return;
		}

		await this.dispatch(projectId, eventType, body);
	}

	private async dispatch(
		projectId: string,
		eventType: string,
		body: any,
	): Promise<void> {
		try {
			if (eventType === "pull_request_review") {
				const review = body?.review;
				const pr = body?.pull_request;
				if (!review || !pr) return;
				await this.reviewEvents.record({
					projectId,
					prNumber: Number(pr.number),
					reviewerLogin: review.user?.login ?? "(unknown)",
					state: review.state ?? "commented",
					submittedAt: new Date(review.submitted_at ?? Date.now()),
					prOpenedAt: new Date(pr.created_at ?? Date.now()),
					prAuthorLogin: pr.user?.login ?? "(unknown)",
					raw: { review, pr_number: pr.number },
				});
			}
			// Other event_types are accepted (idempotency row written) but
			// silently no-op until PR-15 wires them up. This keeps GitHub
			// from disabling the webhook on unhandled events.
		} catch (err) {
			this.log.warn(
				`webhook dispatch ${eventType} failed: ${(err as Error).message}`,
			);
		}
	}

	private async loadProject(projectId: string): Promise<{
		id: string;
		github_webhook_secret: string | null;
	} | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{ id: string; github_webhook_secret: string | null }>
			>(
				`SELECT id, github_webhook_secret
				 FROM clickup_tracker.projects
				 WHERE id = $1::uuid AND status <> 'removed'`,
				projectId,
			);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}
