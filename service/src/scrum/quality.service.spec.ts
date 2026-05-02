import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import {
	QualityService,
	coverageDeltaPct,
	formatCoverageDelta,
	lintErrorDelta,
} from "./quality.service";

describe("QualityService.recordQuality", () => {
	const fakePrisma = {
		$executeRawUnsafe: jest.fn(),
		$queryRawUnsafe: jest.fn(),
	};
	let svc: QualityService;

	beforeEach(async () => {
		fakePrisma.$executeRawUnsafe.mockReset();
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				QualityService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(QualityService);
	});

	it("UPSERTs and reports inserted=true on row count > 0", async () => {
		fakePrisma.$executeRawUnsafe.mockResolvedValue(1);
		const out = await svc.recordQuality({
			projectId: "PID",
			commitSha: "abc",
			coveragePct: 87.5,
			lintErrors: 2,
		});
		expect(out.inserted).toBe(true);
		const sql = fakePrisma.$executeRawUnsafe.mock.calls[0][0];
		expect(sql).toMatch(/commit_quality/);
		expect(sql).toMatch(/ON CONFLICT/);
	});

	it("returns inserted=false on Postgres error", async () => {
		fakePrisma.$executeRawUnsafe.mockRejectedValue(new Error("conn"));
		const out = await svc.recordQuality({
			projectId: "PID",
			commitSha: "abc",
		});
		expect(out.inserted).toBe(false);
	});

	it("previousQualityRow returns the prior row or null", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
		expect(await svc.previousQualityRow("PID", "abc")).toBeNull();
		fakePrisma.$queryRawUnsafe.mockResolvedValueOnce([
			{
				commit_sha: "prev",
				coverage_pct: 80,
				lint_errors: 1,
				lint_warnings: 5,
				test_count: 100,
				test_failed: 0,
				computed_at: new Date(),
			},
		]);
		const row = await svc.previousQualityRow("PID", "abc");
		expect(row?.commit_sha).toBe("prev");
	});
});

describe("coverageDeltaPct / lintErrorDelta / formatCoverageDelta", () => {
	it("coverageDeltaPct rounds to 2 decimal places", () => {
		expect(
			coverageDeltaPct({ coverage_pct: 87.5 }, { coverage_pct: 86.41 }),
		).toBe(1.09);
	});

	it("returns null when either side missing coverage", () => {
		expect(
			coverageDeltaPct({ coverage_pct: null }, { coverage_pct: 80 }),
		).toBeNull();
		expect(
			coverageDeltaPct({ coverage_pct: 80 }, { coverage_pct: null }),
		).toBeNull();
		expect(coverageDeltaPct(null, { coverage_pct: 80 })).toBeNull();
	});

	it("lintErrorDelta is plain subtraction", () => {
		expect(lintErrorDelta({ lint_errors: 5 }, { lint_errors: 3 })).toBe(2);
		expect(
			lintErrorDelta({ lint_errors: null }, { lint_errors: 3 }),
		).toBeNull();
	});

	it("formatCoverageDelta renders signed % with — for null", () => {
		expect(formatCoverageDelta(2.5)).toBe("+2.50%");
		expect(formatCoverageDelta(-1.2)).toBe("-1.20%");
		expect(formatCoverageDelta(0)).toBe("0.00%");
		expect(formatCoverageDelta(null)).toBe("—");
	});
});
