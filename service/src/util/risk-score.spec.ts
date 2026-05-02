import { bandForScore, computeRiskScore, tagsForBand } from "./risk-score";

describe("computeRiskScore", () => {
	it("returns 0 for fully empty input", () => {
		expect(computeRiskScore({})).toBe(0);
	});

	it("clamps negative inputs at 0", () => {
		expect(
			computeRiskScore({
				churn30d: -5,
				bugsReferencing30d: -1,
				linesOfCode: -100,
				ageSinceLastTestChangeDays: -30,
			}),
		).toBe(0);
	});

	it("computes the weighted formula and rounds to 2dp", () => {
		// log1p(20)*0.4 + 2*1.5 + (500/1000)*0.2 + (90/90)*0.3
		// = 1.218*… + 3 + 0.1 + 0.3 ≈ 4.62 (depending on rounding)
		const out = computeRiskScore({
			churn30d: 20,
			bugsReferencing30d: 2,
			linesOfCode: 500,
			ageSinceLastTestChangeDays: 90,
		});
		expect(out).toBeGreaterThan(4.5);
		expect(out).toBeLessThan(4.8);
	});

	it("scales with bug references most aggressively", () => {
		const noBugs = computeRiskScore({ churn30d: 100 });
		const oneBug = computeRiskScore({ churn30d: 100, bugsReferencing30d: 1 });
		expect(oneBug - noBugs).toBeCloseTo(1.5, 2);
	});
});

describe("bandForScore", () => {
	it("classifies thresholds correctly", () => {
		expect(bandForScore(0)).toBe("low");
		expect(bandForScore(2.4)).toBe("low");
		expect(bandForScore(2.5)).toBe("medium");
		expect(bandForScore(4.99)).toBe("medium");
		expect(bandForScore(5)).toBe("high");
		expect(bandForScore(7.99)).toBe("high");
		expect(bandForScore(8)).toBe("critical");
		expect(bandForScore(99)).toBe("critical");
	});
});

describe("tagsForBand", () => {
	it("low/medium → no tags", () => {
		expect(tagsForBand("low")).toEqual([]);
		expect(tagsForBand("medium")).toEqual([]);
	});

	it("high → ['risk-high']", () => {
		expect(tagsForBand("high")).toEqual(["risk-high"]);
	});

	it("critical → ['risk-high', 'risk-critical']", () => {
		expect(tagsForBand("critical")).toEqual(["risk-high", "risk-critical"]);
	});
});
