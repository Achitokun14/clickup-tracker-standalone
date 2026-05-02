import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §I.1 + §I.2 — PR review event ingestion + Review SLA computation.
 *
 * Ingestion: writes a row per `pull_request_review.submitted` (or
 * polled-equivalent) event into `github_review_events`. Idempotent via the
 * unique index on (project_id, pr_number, reviewer_login, submitted_at).
 *
 * SLA: computes per-reviewer rolling stats over the last N days. Surfaced
 * in the retro Doc page (Phase G.2 → extended in v0.5.0) and used by Phase
 * K.5 (auto-suggest reviewers) to identify slow reviewers.
 *
 * The webhook controller / poll cron that *writes* into this service lives
 * in PR-14 (Phase M.1). PR-6 just installs the data plane + SLA reader so
 * downstream callers can use it.
 */
@Injectable()
export class ReviewEventsService {
	private readonly log = new Logger(ReviewEventsService.name);

	constructor(private readonly prisma: PrismaService) {}

	async record(input: {
		projectId: string;
		prNumber: number;
		reviewerLogin: string;
		state: "approved" | "changes_requested" | "commented" | string;
		submittedAt: Date;
		prOpenedAt: Date;
		prAuthorLogin: string;
		raw?: unknown;
	}): Promise<{ inserted: boolean }> {
		try {
			const r = await this.prisma.$executeRawUnsafe(
				`INSERT INTO clickup_tracker.github_review_events
				   (project_id, pr_number, reviewer_login, state,
				    submitted_at, pr_opened_at, pr_author_login, raw)
				 VALUES ($1::uuid, $2, $3, $4, $5::timestamptz,
				         $6::timestamptz, $7, $8::jsonb)
				 ON CONFLICT (project_id, pr_number, reviewer_login, submitted_at)
				 DO NOTHING`,
				input.projectId,
				input.prNumber,
				input.reviewerLogin,
				input.state,
				input.submittedAt.toISOString(),
				input.prOpenedAt.toISOString(),
				input.prAuthorLogin,
				JSON.stringify(input.raw ?? null),
			);
			return { inserted: r > 0 };
		} catch (err) {
			this.log.warn(
				`review-event insert failed (pr=${input.prNumber}, reviewer=${input.reviewerLogin}): ${(err as Error).message}`,
			);
			return { inserted: false };
		}
	}

	async slaForProject(
		projectId: string,
		windowDays = 30,
	): Promise<ReviewerSla[]> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					reviewer_login: string;
					reviews: bigint;
					approvals: bigint;
					rejections: bigint;
					avg_hours: string | number | null;
				}>
			>(
				`SELECT reviewer_login,
				        COUNT(*)::bigint AS reviews,
				        COUNT(*) FILTER (WHERE state = 'approved')::bigint AS approvals,
				        COUNT(*) FILTER (WHERE state = 'changes_requested')::bigint AS rejections,
				        AVG(EXTRACT(EPOCH FROM (submitted_at - pr_opened_at)) / 3600.0)
				          AS avg_hours
				 FROM clickup_tracker.github_review_events
				 WHERE project_id = $1::uuid
				   AND submitted_at > NOW() - ($2::int || ' days')::interval
				 GROUP BY reviewer_login
				 ORDER BY reviews DESC, reviewer_login ASC`,
				projectId,
				windowDays,
			);
			return rows.map((r) => ({
				reviewerLogin: r.reviewer_login,
				reviews: Number(r.reviews ?? 0),
				approvals: Number(r.approvals ?? 0),
				rejections: Number(r.rejections ?? 0),
				avgHours: r.avg_hours == null ? null : Number(r.avg_hours),
			}));
		} catch (err) {
			this.log.debug(
				`slaForProject(${projectId}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}

export interface ReviewerSla {
	reviewerLogin: string;
	reviews: number;
	approvals: number;
	rejections: number;
	avgHours: number | null;
}

/**
 * Plan §I.2 — render a "Review SLA" retro section. Pure (no I/O) so it can
 * be inlined into renderRetroMd. Slow reviewers (avg > thresholdHours) are
 * marked with a ⏰ emoji — comment-only, never punitive.
 */
export function renderReviewSlaMd(
	rows: ReviewerSla[],
	thresholdHours = 24,
): string {
	if (rows.length === 0) {
		return "_No PR reviews recorded in this window._";
	}
	const lines: string[] = [];
	lines.push("| Reviewer | Reviews | ✓ | ✗ | Avg turnaround |");
	lines.push("|---|---|---|---|---|");
	for (const r of rows) {
		const slow = r.avgHours != null && r.avgHours > thresholdHours ? " ⏰" : "";
		const avg = r.avgHours == null ? "—" : `${r.avgHours.toFixed(1)}h${slow}`;
		lines.push(
			`| ${r.reviewerLogin} | ${r.reviews} | ${r.approvals} | ${r.rejections} | ${avg} |`,
		);
	}
	return lines.join("\n");
}
