import { compareIsoWeekKeys, isoWeekOf, ymd } from "./iso-week";

describe("isoWeekOf", () => {
	it("Monday 2024-01-08 → 2024-W02 (Mon..Sun)", () => {
		const w = isoWeekOf(new Date("2024-01-08T12:00:00Z"));
		expect(w.key).toBe("2024-W02");
		expect(w.year).toBe(2024);
		expect(w.week).toBe(2);
		expect(w.startDate).toBe("2024-01-08");
		expect(w.endDate).toBe("2024-01-14");
	});

	it("Sunday 2023-01-01 belongs to ISO 2022-W52", () => {
		const w = isoWeekOf(new Date("2023-01-01T12:00:00Z"));
		expect(w.key).toBe("2022-W52");
		expect(w.startDate).toBe("2022-12-26");
		expect(w.endDate).toBe("2023-01-01");
	});

	it("Monday 2024-12-30 belongs to ISO 2025-W01", () => {
		const w = isoWeekOf(new Date("2024-12-30T12:00:00Z"));
		expect(w.key).toBe("2025-W01");
		expect(w.startDate).toBe("2024-12-30");
		expect(w.endDate).toBe("2025-01-05");
	});

	it("ISO week 53 occurs in 2020", () => {
		// 2020-12-31 was Thursday; week 53 of 2020 covers 2020-12-28..2021-01-03
		const w = isoWeekOf(new Date("2020-12-31T12:00:00Z"));
		expect(w.key).toBe("2020-W53");
	});

	it("keys are lexicographically sortable across year boundaries", () => {
		expect(compareIsoWeekKeys("2023-W52", "2024-W01")).toBeLessThan(0);
		expect(compareIsoWeekKeys("2024-W09", "2024-W10")).toBeLessThan(0);
	});

	it("ymd uses UTC components", () => {
		expect(ymd(new Date("2024-03-15T23:30:00Z"))).toBe("2024-03-15");
	});
});
