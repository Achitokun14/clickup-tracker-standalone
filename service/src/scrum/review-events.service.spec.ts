import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import {
	ReviewEventsService,
	renderReviewSlaMd,
} from "./review-events.service";

describe("ReviewEventsService.record", () => {
	const fakePrisma = {
		$executeRawUnsafe: jest.fn(),
		$queryRawUnsafe: jest.fn(),
	};
	let svc: ReviewEventsService;

	beforeEach(async () => {
		fakePrisma.$executeRawUnsafe.mockReset();
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				ReviewEventsService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(ReviewEventsService);
	});

	it("returns inserted=true when the INSERT writes a row", async () => {
		fakePrisma.$executeRawUnsafe.mockResolvedValue(1);
		const out = await svc.record({
			projectId: "PID",
			prNumber: 12,
			reviewerLogin: "alice",
			state: "approved",
			submittedAt: new Date("2026-05-02T12:00:00Z"),
			prOpenedAt: new Date("2026-05-02T10:00:00Z"),
			prAuthorLogin: "bob",
		});
		expect(out.inserted).toBe(true);
		expect(fakePrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
		const sql = fakePrisma.$executeRawUnsafe.mock.calls[0][0];
		expect(sql).toMatch(/github_review_events/);
		expect(sql).toMatch(/ON CONFLICT/);
	});

	it("returns inserted=false when ON CONFLICT skips", async () => {
		fakePrisma.$executeRawUnsafe.mockResolvedValue(0);
		const out = await svc.record({
			projectId: "PID",
			prNumber: 12,
			reviewerLogin: "alice",
			state: "approved",
			submittedAt: new Date("2026-05-02T12:00:00Z"),
			prOpenedAt: new Date("2026-05-02T10:00:00Z"),
			prAuthorLogin: "bob",
		});
		expect(out.inserted).toBe(false);
	});

	it("survives a Postgres write error and reports inserted=false", async () => {
		fakePrisma.$executeRawUnsafe.mockRejectedValue(new Error("conn lost"));
		const out = await svc.record({
			projectId: "PID",
			prNumber: 12,
			reviewerLogin: "alice",
			state: "approved",
			submittedAt: new Date("2026-05-02T12:00:00Z"),
			prOpenedAt: new Date("2026-05-02T10:00:00Z"),
			prAuthorLogin: "bob",
		});
		expect(out.inserted).toBe(false);
	});
});

describe("ReviewEventsService.slaForProject", () => {
	const fakePrisma = {
		$executeRawUnsafe: jest.fn(),
		$queryRawUnsafe: jest.fn(),
	};
	let svc: ReviewEventsService;

	beforeEach(async () => {
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				ReviewEventsService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(ReviewEventsService);
	});

	it("normalises bigint counts + numeric avg_hours", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([
			{
				reviewer_login: "alice",
				reviews: 10n,
				approvals: 7n,
				rejections: 1n,
				avg_hours: "12.5",
			},
		]);
		const out = await svc.slaForProject("PID", 30);
		expect(out).toEqual([
			{
				reviewerLogin: "alice",
				reviews: 10,
				approvals: 7,
				rejections: 1,
				avgHours: 12.5,
			},
		]);
	});

	it("handles null avg_hours (no rows in window)", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([]);
		const out = await svc.slaForProject("PID", 30);
		expect(out).toEqual([]);
	});

	it("returns [] on query error", async () => {
		fakePrisma.$queryRawUnsafe.mockRejectedValue(new Error("boom"));
		const out = await svc.slaForProject("PID", 30);
		expect(out).toEqual([]);
	});
});

describe("renderReviewSlaMd", () => {
	it("returns placeholder when empty", () => {
		expect(renderReviewSlaMd([])).toContain("No PR reviews");
	});

	it("flags slow reviewers with ⏰", () => {
		const md = renderReviewSlaMd([
			{
				reviewerLogin: "slow",
				reviews: 5,
				approvals: 3,
				rejections: 1,
				avgHours: 48,
			},
			{
				reviewerLogin: "fast",
				reviews: 10,
				approvals: 9,
				rejections: 0,
				avgHours: 4,
			},
		]);
		expect(md).toContain("48.0h ⏰");
		expect(md).toContain("4.0h |"); // no clock for fast
		expect(md).not.toMatch(/4\.0h ⏰/);
	});

	it("renders — when avgHours is null", () => {
		const md = renderReviewSlaMd([
			{
				reviewerLogin: "lurker",
				reviews: 0,
				approvals: 0,
				rejections: 0,
				avgHours: null,
			},
		]);
		expect(md).toContain("| — |");
	});
});
