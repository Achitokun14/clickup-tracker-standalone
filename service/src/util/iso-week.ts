/**
 * ISO 8601 week-numbering. Pure functions; no third-party deps (CARL rule #2).
 *
 * The ISO week-year may differ from the calendar year for late December and
 * early January days. Examples:
 *   2023-01-01 (Sun) → 2022-W52
 *   2024-12-30 (Mon) → 2025-W01
 *   2025-12-29 (Mon) → 2026-W01
 */

export interface IsoWeek {
	/** Compact key like "2026-W17". Lexicographically sortable. */
	key: string;
	/** ISO week-year (4 digits). */
	year: number;
	/** ISO week ordinal (1..53). */
	week: number;
	/** Calendar date of the Monday that opens the week (yyyy-mm-dd, UTC). */
	startDate: string;
	/** Calendar date of the Sunday that closes the week (yyyy-mm-dd, UTC). */
	endDate: string;
}

/** Returns the ISO week info for a given Date (UTC interpretation). */
export function isoWeekOf(date: Date): IsoWeek {
	// Algorithm follows the canonical "Calculating the week number from an
	// ordinal date" recipe (see Wikipedia: ISO_8601 § Calculating_the_week_number).
	// Work in UTC to avoid TZ-induced drift.
	const target = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	// ISO weekday: Mon=1 ... Sun=7
	const dayNum = ((target.getUTCDay() + 6) % 7) + 1;
	// Roll target to the Thursday of its ISO week — Thursday determines the year.
	target.setUTCDate(target.getUTCDate() + (4 - dayNum));
	const year = target.getUTCFullYear();
	const firstThursday = new Date(Date.UTC(year, 0, 4));
	const firstThursdayDayNum = ((firstThursday.getUTCDay() + 6) % 7) + 1;
	firstThursday.setUTCDate(
		firstThursday.getUTCDate() + (4 - firstThursdayDayNum),
	);
	const week =
		1 +
		Math.round(
			(target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
		);

	// Compute the Monday of `date`'s ISO week (start) and Sunday (end).
	const monday = new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate() - (dayNum - 1),
		),
	);
	const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);

	return {
		key: `${year}-W${String(week).padStart(2, "0")}`,
		year,
		week,
		startDate: ymd(monday),
		endDate: ymd(sunday),
	};
}

/** Convenience: format a date as YYYY-MM-DD using its UTC components. */
export function ymd(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Compare two IsoWeek keys chronologically. */
export function compareIsoWeekKeys(a: string, b: string): number {
	return a.localeCompare(b);
}
