import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
	bandForScore,
	computeRiskScore,
	type RiskBand,
} from "../util/risk-score";

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

	/**
	 * Plan §L.3 — compute the per-file risk-score table for a project.
	 * Materialised on demand (not yet a table); cheap enough to recompute
	 * inside the daily groomer cron.
	 */
	async computeRiskScores(
		projectId: string,
		opts: { topN?: number } = {},
	): Promise<RiskScoreRow[]> {
		const topN = opts.topN ?? 50;
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					path: string;
					churn30d: bigint | number;
					bugs30d: bigint | number;
					lines_of_code: bigint | number;
					last_test_age_days: number | null;
				}>
			>(
				`WITH per_file AS (
				   SELECT (jsonb_array_elements(g.files_changed::jsonb)->>'path') AS path,
				          COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'additions')::int, 0)
				            + COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'deletions')::int, 0)
				              AS deltas,
				          g.created_at,
				          g.message
				   FROM clickup_tracker.git_events g
				   WHERE g.project_id = $1::uuid
				     AND g.files_changed IS NOT NULL
				 ),
				 churn AS (
				   SELECT path,
				          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::bigint
				            AS churn30d,
				          SUM(deltas)::bigint AS lines_of_code
				   FROM per_file
				   GROUP BY path
				 ),
				 bugs AS (
				   SELECT path,
				          COUNT(*) FILTER (WHERE message ~* '\\b(fix|bug)\\b'
				                            AND created_at > NOW() - INTERVAL '30 days')::bigint
				            AS bugs30d
				   FROM per_file
				   GROUP BY path
				 ),
				 last_test AS (
				   SELECT path,
				          EXTRACT(DAY FROM NOW() - MAX(created_at))::int AS last_test_age_days
				   FROM per_file
				   WHERE path ~* '(spec|test)\\.(ts|js|py|go|rb)$'
				   GROUP BY path
				 )
				 SELECT c.path,
				        c.churn30d,
				        COALESCE(b.bugs30d, 0::bigint) AS bugs30d,
				        c.lines_of_code,
				        lt.last_test_age_days
				 FROM churn c
				 LEFT JOIN bugs b USING (path)
				 LEFT JOIN last_test lt USING (path)
				 WHERE c.churn30d > 0
				 ORDER BY c.churn30d DESC
				 LIMIT $2`,
				projectId,
				topN,
			);
			return rows.map((r) => {
				const inputs = {
					churn30d: Number(r.churn30d ?? 0),
					bugsReferencing30d: Number(r.bugs30d ?? 0),
					linesOfCode: Number(r.lines_of_code ?? 0),
					ageSinceLastTestChangeDays: r.last_test_age_days ?? null,
				};
				const score = computeRiskScore(inputs);
				return {
					path: r.path,
					score,
					band: bandForScore(score),
					inputs,
				};
			});
		} catch (err) {
			this.log.debug(
				`computeRiskScores(${projectId}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}

export interface RiskScoreRow {
	path: string;
	score: number;
	band: RiskBand;
	inputs: {
		churn30d: number;
		bugsReferencing30d: number;
		linesOfCode: number;
		ageSinceLastTestChangeDays: number | null;
	};
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

/**
 * Plan §L.3 + §K.1 — render a Risk Register Markdown table from a list
 * of computed risk scores. Used both by the per-project Risk Register
 * Doc page and by the workspace rollup K.1 page.
 */
export function renderRiskRegisterMd(rows: RiskScoreRow[]): string {
	const lines: string[] = [];
	lines.push("# Risk Register");
	lines.push("");
	lines.push(
		"_Auto-managed — refreshed nightly. Risk = log1p(churn) × 0.4 + bugs × 1.5 + LOC/1000 × 0.2 + test_age/90 × 0.3._",
	);
	lines.push("");
	if (rows.length === 0) {
		lines.push("_No files cross the risk threshold yet._");
		return lines.join("\n");
	}
	lines.push(
		"| Path | Score | Band | Churn 30d | Bugs 30d | LOC | Test age (d) |",
	);
	lines.push("|---|---|---|---|---|---|---|");
	for (const r of rows) {
		const bandIcon =
			r.band === "critical"
				? "🚨 critical"
				: r.band === "high"
					? "🟧 high"
					: r.band === "medium"
						? "🟨 medium"
						: "🟢 low";
		lines.push(
			`| \`${r.path}\` | ${r.score.toFixed(2)} | ${bandIcon} | ${r.inputs.churn30d} | ${r.inputs.bugsReferencing30d} | ${r.inputs.linesOfCode} | ${r.inputs.ageSinceLastTestChangeDays ?? "—"} |`,
		);
	}
	return lines.join("\n");
}
