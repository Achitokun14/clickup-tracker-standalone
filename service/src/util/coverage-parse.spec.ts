import { parseCoverageReport } from "./coverage-parse";

describe("parseCoverageReport", () => {
	it("returns null on null/empty/unrecognised input", () => {
		expect(parseCoverageReport(null)).toBeNull();
		expect(parseCoverageReport("")).toBeNull();
		expect(parseCoverageReport("just some text")).toBeNull();
	});

	it("parses LCOV (LF + LH per file, summed)", () => {
		const lcov = [
			"TN:",
			"SF:src/a.ts",
			"LF:100",
			"LH:80",
			"end_of_record",
			"SF:src/b.ts",
			"LF:50",
			"LH:30",
			"end_of_record",
		].join("\n");
		const out = parseCoverageReport(lcov);
		expect(out).toEqual({ coveragePct: 73.33 }); // (80+30)/(100+50)*100
	});

	it("parses cobertura XML line-rate attribute", () => {
		const xml = `<?xml version="1.0"?><coverage line-rate="0.8721" branch-rate="0.5">…</coverage>`;
		expect(parseCoverageReport(xml)).toEqual({ coveragePct: 87.21 });
	});

	it("parses istanbul JSON summary (statements.pct preferred)", () => {
		const json = JSON.stringify({
			total: { statements: { pct: 91.5 }, lines: { pct: 88.0 } },
		});
		expect(parseCoverageReport(json)).toEqual({ coveragePct: 91.5 });
	});

	it("falls back to lines.pct when statements is missing", () => {
		const json = JSON.stringify({ total: { lines: { pct: 77.7 } } });
		expect(parseCoverageReport(json)).toEqual({ coveragePct: 77.7 });
	});

	it("returns null on broken JSON", () => {
		expect(parseCoverageReport("{not json")).toBeNull();
	});
});
