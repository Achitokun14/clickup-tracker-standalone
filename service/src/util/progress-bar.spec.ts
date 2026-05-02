import { bar, ratio, sparkline } from "./progress-bar";

describe("bar", () => {
	it("renders 0% as all empty", () => {
		const out = bar(0, 10, 16);
		expect(out).toMatch(/^░{16} 0% \(0\/10\)$/);
	});

	it("renders 100% as all filled", () => {
		const out = bar(10, 10, 16);
		expect(out).toMatch(/^█{16} 100% \(10\/10\)$/);
	});

	it("renders ~50% as half filled", () => {
		const out = bar(5, 10, 16);
		expect(out).toMatch(/^█{8}░{8} 50%/);
	});

	it("clamps overshoot to total (capped at 100%)", () => {
		const out = bar(15, 10, 16);
		expect(out).toMatch(/100%/);
	});

	it("clamps negative to 0%", () => {
		const out = bar(-3, 10, 16);
		expect(out).toMatch(/0%/);
	});

	it("returns no-data bar when total is 0", () => {
		expect(bar(0, 0, 16)).toBe("░░░░░░░░░░░░░░░░ (no data)");
	});
});

describe("sparkline", () => {
	it("returns empty string for empty input", () => {
		expect(sparkline([])).toBe("");
	});

	it("renders all-zero as flat bottom bars", () => {
		expect(sparkline([0, 0, 0])).toBe("▁▁▁");
	});

	it("scales monotonic increasing series — last is the tallest bar", () => {
		const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(out.length).toBe(8);
		// Series maxes out at index N — ratio rounding means the first
		// non-zero value lands one step above the floor, but the last
		// must always hit the full block.
		expect(out[out.length - 1]).toBe("█");
		// Strictly non-decreasing.
		const order = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
		for (let i = 1; i < out.length; i++) {
			expect(order.indexOf(out[i])).toBeGreaterThanOrEqual(
				order.indexOf(out[i - 1]),
			);
		}
	});

	it("treats a true zero in a non-zero series as the floor bar", () => {
		const out = sparkline([0, 8]);
		expect(out[0]).toBe("▁");
		expect(out[1]).toBe("█");
	});

	it("renders a single value as a single full bar", () => {
		expect(sparkline([5])).toBe("█");
	});

	it("treats negative values as zero", () => {
		const out = sparkline([-5, 0, 5]);
		expect(out[0]).toBe("▁");
	});
});

describe("ratio", () => {
	it("formats N/M (P%)", () => {
		expect(ratio(3, 10)).toBe("3/10 (30%)");
	});

	it("returns 0/0 on zero total", () => {
		expect(ratio(5, 0)).toBe("0/0");
	});

	it("rounds 50% (5/10)", () => {
		expect(ratio(5, 10)).toBe("5/10 (50%)");
	});
});
