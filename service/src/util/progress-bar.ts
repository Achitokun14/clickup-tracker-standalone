/**
 * Visual helpers for Doc pages — Unicode progress bars and sparklines.
 * No deps; safe to render in CU's Markdown viewer.
 */

const BLOCK_FULL = "█";
const BLOCK_EMPTY = "░";

/**
 * Horizontal progress bar like `████████░░░░░░░░ 50% (4/8)`.
 *
 * @param done   completed count (clamped 0..total)
 * @param total  denominator (returns "no data" bar when 0)
 * @param width  number of cells in the bar (default 16)
 */
export function bar(done: number, total: number, width = 16): string {
	if (!Number.isFinite(total) || total <= 0) {
		return `${BLOCK_EMPTY.repeat(width)} (no data)`;
	}
	const clamped = Math.max(0, Math.min(done, total));
	const filled = Math.round((clamped / total) * width);
	const empty = Math.max(0, width - filled);
	const pct = Math.round((clamped / total) * 100);
	return (
		BLOCK_FULL.repeat(filled) +
		BLOCK_EMPTY.repeat(empty) +
		` ${pct}% (${Math.round(clamped)}/${Math.round(total)})`
	);
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Unicode sparkline. Maps each value to one of 8 height bars relative to
 * the series max. Empty / all-zero series renders as flat bottom bars.
 */
export function sparkline(values: number[]): string {
	if (values.length === 0) return "";
	const max = Math.max(...values, 0);
	if (max === 0) return SPARK_CHARS[0].repeat(values.length);
	return values
		.map((v) => {
			const safe = Math.max(0, v);
			const idx = Math.min(
				SPARK_CHARS.length - 1,
				Math.round((safe / max) * (SPARK_CHARS.length - 1)),
			);
			return SPARK_CHARS[idx];
		})
		.join("");
}

/**
 * Format a count + total into "N/M (P%)" without the bar — useful in
 * inline table cells where the bar would wrap awkwardly.
 */
export function ratio(done: number, total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0/0";
	const pct = Math.round((Math.max(0, done) / total) * 100);
	return `${Math.round(done)}/${Math.round(total)} (${pct}%)`;
}
