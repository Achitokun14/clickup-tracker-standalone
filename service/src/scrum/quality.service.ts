import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §L.1 + §L.2 — quality signals data plane.
 *
 *   recordQuality(input)        → upsert clickup_tracker.commit_quality
 *   coverageDeltaPct(project, sha) → current vs previous-commit coverage
 *   lintDelta(project, sha)        → current vs previous-commit lint counts
 *
 * Reading the "previous commit" is the most recent commit_quality row for
 * the same project with computed_at < this row's computed_at. Writes are
 * idempotent via the (project_id, commit_sha) PK from schema/05.
 */

export interface QualityInput {
	projectId: string;
	commitSha: string;
	coveragePct?: number | null;
	lintErrors?: number | null;
	lintWarnings?: number | null;
	testCount?: number | null;
	testFailed?: number | null;
}

export interface QualityRow {
	commit_sha: string;
	coverage_pct: number | null;
	lint_errors: number | null;
	lint_warnings: number | null;
	test_count: number | null;
	test_failed: number | null;
	computed_at: Date;
}

@Injectable()
export class QualityService {
	private readonly log = new Logger(QualityService.name);

	constructor(private readonly prisma: PrismaService) {}

	async recordQuality(input: QualityInput): Promise<{ inserted: boolean }> {
		try {
			const r = await this.prisma.$executeRawUnsafe(
				`INSERT INTO clickup_tracker.commit_quality
				   (project_id, commit_sha, coverage_pct, lint_errors,
				    lint_warnings, test_count, test_failed, computed_at)
				 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, NOW())
				 ON CONFLICT (project_id, commit_sha) DO UPDATE SET
				   coverage_pct  = EXCLUDED.coverage_pct,
				   lint_errors   = EXCLUDED.lint_errors,
				   lint_warnings = EXCLUDED.lint_warnings,
				   test_count    = EXCLUDED.test_count,
				   test_failed   = EXCLUDED.test_failed,
				   computed_at   = NOW()`,
				input.projectId,
				input.commitSha,
				input.coveragePct ?? null,
				input.lintErrors ?? null,
				input.lintWarnings ?? null,
				input.testCount ?? null,
				input.testFailed ?? null,
			);
			return { inserted: r > 0 };
		} catch (err) {
			this.log.warn(
				`recordQuality(${input.commitSha}) failed: ${(err as Error).message}`,
			);
			return { inserted: false };
		}
	}

	async previousQualityRow(
		projectId: string,
		commitSha: string,
	): Promise<QualityRow | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<QualityRow[]>(
				`SELECT commit_sha, coverage_pct, lint_errors, lint_warnings,
				        test_count, test_failed, computed_at
				 FROM clickup_tracker.commit_quality
				 WHERE project_id = $1::uuid
				   AND commit_sha <> $2
				   AND computed_at < (
				     SELECT COALESCE(MAX(computed_at), NOW())
				     FROM clickup_tracker.commit_quality
				     WHERE project_id = $1::uuid AND commit_sha = $2
				   )
				 ORDER BY computed_at DESC
				 LIMIT 1`,
				projectId,
				commitSha,
			);
			return rows[0] ?? null;
		} catch (err) {
			this.log.debug(
				`previousQualityRow(${commitSha}) failed: ${(err as Error).message}`,
			);
			return null;
		}
	}
}

/** Delta arithmetic — pure helpers so callers can render comments without
 *  hitting the DB twice. Returns null when either side is missing data. */
export function coverageDeltaPct(
	current: { coverage_pct: number | null } | null,
	previous: { coverage_pct: number | null } | null,
): number | null {
	if (current?.coverage_pct == null || previous?.coverage_pct == null) {
		return null;
	}
	return Math.round((current.coverage_pct - previous.coverage_pct) * 100) / 100;
}

export function lintErrorDelta(
	current: { lint_errors: number | null } | null,
	previous: { lint_errors: number | null } | null,
): number | null {
	if (current?.lint_errors == null || previous?.lint_errors == null)
		return null;
	return current.lint_errors - previous.lint_errors;
}

export function formatCoverageDelta(delta: number | null): string {
	if (delta == null) return "—";
	const sign = delta > 0 ? "+" : "";
	return `${sign}${delta.toFixed(2)}%`;
}
