import {
	estimateMinutesForSprintTask,
	summariseTimeEntries,
} from "./time-tracking";

describe("estimateMinutesForSprintTask", () => {
	it("returns 60 for a feat with no churn signal", () => {
		// base=15, mul=1.0 (feat), no subtask boost → 15 minutes
		expect(estimateMinutesForSprintTask({ conventionalType: "feat" })).toBe(15);
	});

	it("scales up with churn", () => {
		// churn=200 → ceil(200/50)*30 = 120; mul(feat)=1.0 → 120
		expect(
			estimateMinutesForSprintTask({ conventionalType: "feat", churn: 200 }),
		).toBe(120);
	});

	it("clamps base at 4h regardless of churn", () => {
		expect(
			estimateMinutesForSprintTask({ conventionalType: "feat", churn: 9999 }),
		).toBe(240);
	});

	it("applies type multiplier (chore × 0.4)", () => {
		// base=120, mul=0.4 → 48
		expect(
			estimateMinutesForSprintTask({ conventionalType: "chore", churn: 200 }),
		).toBe(48);
	});

	it("falls back to 0.7 multiplier for unknown types", () => {
		// base=120, mul=0.7 → 84
		expect(
			estimateMinutesForSprintTask({ conventionalType: "wat", churn: 200 }),
		).toBe(84);
	});

	it("adds 10 minutes per subtask above 1", () => {
		// base=15, mul=1.0, subtaskCount=4 → +30 → 45
		expect(
			estimateMinutesForSprintTask({
				conventionalType: "feat",
				subtaskCount: 4,
			}),
		).toBe(45);
	});
});

describe("summariseTimeEntries", () => {
	it("sums entry durations and converts to minutes", () => {
		const out = summariseTimeEntries({
			estimateMinutes: 60,
			entries: [{ duration: 30 * 60_000 }, { duration: 45 * 60_000 }],
		});
		expect(out.actualMinutes).toBe(75);
		expect(out.variancePct).toBe(25);
	});

	it("returns 0 variance when estimate is 0", () => {
		const out = summariseTimeEntries({
			estimateMinutes: 0,
			entries: [{ duration: 60_000 }],
		});
		expect(out.variancePct).toBe(0);
	});

	it("rounds variance to nearest integer", () => {
		const out = summariseTimeEntries({
			estimateMinutes: 60,
			entries: [{ duration: 70 * 60_000 }],
		});
		expect(out.variancePct).toBe(17); // (70-60)/60 = 16.66… → 17
	});
});
