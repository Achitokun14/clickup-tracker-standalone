/**
 * Plan §J.1 — time tracking helpers.
 *
 * Estimate heuristics: derive a time_estimate (minutes) for a sprint task
 * from its size signals. The sprint planner calls this when moving a task
 * into Active Sprint so CU's native time-estimate field is populated even
 * when the operator hasn't manually estimated.
 *
 * Roll-up: aggregate time-entries to compute actual vs estimated for the
 * retro page. Uses ClickUpDirectService.listTimeEntriesForTask.
 */

const TYPE_MULTIPLIER: Record<string, number> = {
	feat: 1.0,
	fix: 0.6,
	refactor: 0.8,
	chore: 0.4,
	docs: 0.3,
	test: 0.5,
};

/**
 * Heuristic: minutes ≈ base × multiplier.
 *
 *   base = max(15, ceil(churn / 50) × 30) clamped to 4h
 *
 * `churn` is `additions + deletions`. Falls back to 60 minutes when no
 * signal is available.
 */
export function estimateMinutesForSprintTask(input: {
	conventionalType?: string;
	churn?: number;
	subtaskCount?: number;
}): number {
	const churn = Math.max(0, input.churn ?? 0);
	const base = Math.min(240, Math.max(15, Math.ceil(churn / 50) * 30));
	const mul =
		TYPE_MULTIPLIER[(input.conventionalType ?? "").toLowerCase()] ?? 0.7;
	const subTaskBoost = Math.max(0, (input.subtaskCount ?? 0) - 1) * 10;
	return Math.round(base * mul + subTaskBoost);
}

export interface TimeRollup {
	estimateMinutes: number;
	actualMinutes: number;
	variancePct: number; // (actual - estimate) / estimate × 100; 0 when estimate=0
}

export function summariseTimeEntries(input: {
	estimateMinutes: number;
	entries: Array<{ duration: number /* ms */ }>;
}): TimeRollup {
	const totalMs = input.entries.reduce((a, e) => a + (e.duration ?? 0), 0);
	const actualMinutes = Math.round(totalMs / 60_000);
	const variancePct =
		input.estimateMinutes > 0
			? Math.round(
					((actualMinutes - input.estimateMinutes) / input.estimateMinutes) *
						100,
				)
			: 0;
	return {
		estimateMinutes: input.estimateMinutes,
		actualMinutes,
		variancePct,
	};
}
