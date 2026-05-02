import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import {
	type FileOwner,
	OwnershipService,
	renderOwnershipMd,
} from "./ownership.service";

describe("OwnershipService.topOwnersForPath", () => {
	const fakePrisma = {
		$queryRawUnsafe: jest.fn(),
	};
	let svc: OwnershipService;

	beforeEach(async () => {
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				OwnershipService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(OwnershipService);
	});

	it("normalises bigint commits + numeric score and ISO last_touched_at", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([
			{
				path: "service/src/foo.ts",
				email: "alice@x.com",
				score: "120.5",
				last_touched_at: new Date("2026-04-30T12:00:00Z"),
				commits: 7n,
			},
		]);
		const out = await svc.topOwnersForPath("PID", "service/src/foo.ts", 3);
		expect(out).toEqual([
			{
				email: "alice@x.com",
				score: 120.5,
				lastTouchedAt: "2026-04-30T12:00:00.000Z",
				commits: 7,
			},
		]);
	});

	it("returns [] on query error", async () => {
		fakePrisma.$queryRawUnsafe.mockRejectedValue(new Error("boom"));
		const out = await svc.topOwnersForPath("PID", "x.ts");
		expect(out).toEqual([]);
	});
});

describe("OwnershipService.topOwnersForProject", () => {
	const fakePrisma = {
		$queryRawUnsafe: jest.fn(),
	};
	let svc: OwnershipService;

	beforeEach(async () => {
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				OwnershipService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(OwnershipService);
	});

	it("groups returned rows into a Map keyed by path", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([
			{
				path: "a.ts",
				email: "alice@x.com",
				score: 100,
				last_touched_at: new Date("2026-04-01T00:00:00Z"),
				commits: 5n,
			},
			{
				path: "a.ts",
				email: "bob@x.com",
				score: 60,
				last_touched_at: new Date("2026-03-20T00:00:00Z"),
				commits: 3n,
			},
			{
				path: "b.ts",
				email: "carol@x.com",
				score: 80,
				last_touched_at: new Date("2026-04-15T00:00:00Z"),
				commits: 4n,
			},
		]);
		const out = await svc.topOwnersForProject("PID");
		expect(out.size).toBe(2);
		expect(out.get("a.ts")).toHaveLength(2);
		expect(out.get("b.ts")).toHaveLength(1);
		expect(out.get("a.ts")![0].email).toBe("alice@x.com");
	});

	it("returns empty Map on error", async () => {
		fakePrisma.$queryRawUnsafe.mockRejectedValue(new Error("conn"));
		const out = await svc.topOwnersForProject("PID");
		expect(out.size).toBe(0);
	});
});

describe("renderOwnershipMd", () => {
	const owner = (email: string, score: number, last: string): FileOwner => ({
		email,
		score,
		lastTouchedAt: last,
		commits: 1,
	});

	it("returns placeholder when no owners", () => {
		const md = renderOwnershipMd(new Map());
		expect(md).toContain("# Ownership");
		expect(md).toContain("waiting for first ingestion");
	});

	it("groups files by top-level directory under <details>", () => {
		const m = new Map<string, FileOwner[]>([
			[
				"service/src/foo.ts",
				[owner("alice@x.com", 100, "2026-04-30T12:00:00Z")],
			],
			["service/src/bar.ts", [owner("bob@x.com", 50, "2026-04-29T12:00:00Z")]],
			["docs/README.md", [owner("carol@x.com", 25, "2026-04-28T12:00:00Z")]],
		]);
		const md = renderOwnershipMd(m);
		expect(md).toContain(
			"<details><summary><strong>service/</strong> (2 files)",
		);
		expect(md).toContain("<details><summary><strong>docs/</strong> (1 files)");
		expect(md).toContain("`alice@x.com`");
		expect(md).toContain("2026-04-30");
	});

	it("renders score rounded as integer in cells", () => {
		const m = new Map<string, FileOwner[]>([
			[
				"x.ts",
				[
					owner("a@x", 100.6, "2026-04-30T00:00:00Z"),
					owner("b@x", 50.4, "2026-04-29T00:00:00Z"),
				],
			],
		]);
		const md = renderOwnershipMd(m);
		expect(md).toContain("`a@x` (101)");
		expect(md).toContain("`b@x` (50)");
	});
});
