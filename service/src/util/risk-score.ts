/**
 * Plan §L.3 — churn-vs-defect risk score per file.
 *
 *   risk_score = log1p(churn_30d)              × 0.4
 *              + bugs_referencing_file_30d     × 1.5
 *              + lines_of_code / 1000          × 0.2
 *              + age_since_last_test_change_d  / 90 × 0.3
 *
 * All inputs default to 0 / null when missing. Returns a single number
 * rounded to 2 dp so it slots into a CU custom field cleanly.
 */

export interface RiskInputs {
	churn30d?: number | null;
	bugsReferencing30d?: number | null;
	linesOfCode?: number | null;
	ageSinceLastTestChangeDays?: number | null;
}

export function computeRiskScore(input: RiskInputs): number {
	const churn = Math.max(0, input.churn30d ?? 0);
	const bugs = Math.max(0, input.bugsReferencing30d ?? 0);
	const loc = Math.max(0, input.linesOfCode ?? 0);
	const age = Math.max(0, input.ageSinceLastTestChangeDays ?? 0);
	const score =
		Math.log1p(churn) * 0.4 +
		bugs * 1.5 +
		(loc / 1000) * 0.2 +
		(age / 90) * 0.3;
	return Math.round(score * 100) / 100;
}

export type RiskBand = "low" | "medium" | "high" | "critical";

export function bandForScore(score: number): RiskBand {
	if (score >= 8) return "critical";
	if (score >= 5) return "high";
	if (score >= 2.5) return "medium";
	return "low";
}

/**
 * Returns the canonical CU tag(s) to apply for a given band. Threshold-based;
 * `high` applies the `risk-high` tag, `critical` applies both `risk-high` AND
 * `risk-critical` so a "show me anything risky" filter still catches it.
 */
export function tagsForBand(band: RiskBand): string[] {
	switch (band) {
		case "critical":
			return ["risk-high", "risk-critical"];
		case "high":
			return ["risk-high"];
		default:
			return [];
	}
}
