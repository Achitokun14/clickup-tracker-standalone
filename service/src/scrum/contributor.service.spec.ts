import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ContributorService } from "./contributor.service";

describe("ContributorService", () => {
	const fakePrisma = {
		$queryRawUnsafe: jest.fn(),
	};
	let svc: ContributorService;

	beforeEach(async () => {
		fakePrisma.$queryRawUnsafe.mockReset();
		const moduleRef = await Test.createTestingModule({
			providers: [
				ContributorService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(ContributorService);
	});

	it("maps SQL rows into Contributor objects with normalised types", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([
			{
				email: "alice@x.com",
				github_login: "alice",
				github_url: "https://github.com/alice",
				avatar_url: "https://avatars/alice.png",
				commits_30d: 17n,
				commits_all_time: 152n,
				first_seen: new Date("2024-01-01T00:00:00Z"),
				last_seen: new Date("2026-05-01T00:00:00Z"),
			},
		]);

		const out = await svc.listForProject("PID");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			email: "alice@x.com",
			githubLogin: "alice",
			githubUrl: "https://github.com/alice",
			avatarUrl: "https://avatars/alice.png",
		});
		expect(out[0].stats.commits30d).toBe(17);
		expect(out[0].stats.commitsAllTime).toBe(152);
		expect(out[0].stats.firstSeen).toBe("2024-01-01T00:00:00.000Z");
	});

	it("handles authors with no github identity (cache miss)", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([
			{
				email: "external@nowhere.io",
				github_login: null,
				github_url: null,
				avatar_url: null,
				commits_30d: 0n,
				commits_all_time: 1n,
				first_seen: new Date("2026-04-01T00:00:00Z"),
				last_seen: new Date("2026-04-01T00:00:00Z"),
			},
		]);

		const out = await svc.listForProject("PID");
		expect(out[0].githubLogin).toBeNull();
		expect(out[0].avatarUrl).toBeNull();
	});

	it("returns [] when project has no commits", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([]);
		const out = await svc.listForProject("PID");
		expect(out).toEqual([]);
	});

	it("issues a single SELECT joining git_events ↔ github_identities", async () => {
		fakePrisma.$queryRawUnsafe.mockResolvedValue([]);
		await svc.listForProject("PID");
		expect(fakePrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
		const sql = fakePrisma.$queryRawUnsafe.mock.calls[0][0];
		expect(sql).toMatch(/git_events/);
		expect(sql).toMatch(/github_identities/);
		expect(sql).toMatch(/COUNT\(\*\)/);
	});
});
