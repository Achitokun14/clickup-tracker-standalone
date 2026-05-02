import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { GithubIdentityService } from "./github-identity.service";

describe("GithubIdentityService", () => {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	type Row = {
		email: string;
		github_login: string | null;
		github_url: string | null;
		avatar_url: string | null;
		resolved_at: Date;
		source: string;
	};
	const cache = new Map<string, Row>();

	const fakePrisma = {
		$queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
			calls.push({ sql, params });
			if (sql.includes("FROM clickup_tracker.github_identities") && params[0]) {
				const row = cache.get((params[0] as string).toLowerCase());
				return row ? [row] : [];
			}
			return [];
		}),
		$executeRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
			calls.push({ sql, params });
			if (sql.includes("INSERT INTO clickup_tracker.github_identities")) {
				const [email, login, url, avatar, source] = params as string[];
				cache.set(email.toLowerCase(), {
					email: email.toLowerCase(),
					github_login: login ?? null,
					github_url: url ?? null,
					avatar_url: avatar ?? null,
					resolved_at: new Date(),
					source,
				});
			}
		}),
	};

	let svc: GithubIdentityService;
	const fetchMock = jest.fn();

	beforeEach(async () => {
		calls.length = 0;
		cache.clear();
		fetchMock.mockReset();
		fakePrisma.$queryRawUnsafe.mockClear();
		fakePrisma.$executeRawUnsafe.mockClear();
		(global as any).fetch = fetchMock;

		const moduleRef = await Test.createTestingModule({
			providers: [
				GithubIdentityService,
				{ provide: PrismaService, useValue: fakePrisma },
			],
		}).compile();
		svc = moduleRef.get(GithubIdentityService);
	});

	afterEach(() => {
		delete (global as any).fetch;
	});

	function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
		return {
			ok: true,
			status: 200,
			headers: new Headers({ "x-ratelimit-remaining": "100", ...headers }),
			json: async () => body,
		};
	}

	it("returns null for empty / malformed email", async () => {
		expect(await svc.resolve("")).toBeNull();
		expect(await svc.resolve("not-an-email")).toBeNull();
	});

	it("serves cache hit without fetching", async () => {
		cache.set("alice@x.com", {
			email: "alice@x.com",
			github_login: "alice",
			github_url: "https://github.com/alice",
			avatar_url: "https://avatars/alice.png",
			resolved_at: new Date(),
			source: "commit-api",
		});

		const id = await svc.resolve("Alice@X.com", {
			commitSha: "abc",
			ownerRepo: "x/y",
			host: "github.com",
		});

		expect(id?.github_login).toBe("alice");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns cached null without re-fetch when negative cache fresh", async () => {
		cache.set("ghost@x.com", {
			email: "ghost@x.com",
			github_login: null,
			github_url: null,
			avatar_url: null,
			resolved_at: new Date(),
			source: "commit-api-miss",
		});

		const id = await svc.resolve("ghost@x.com", {
			commitSha: "sha",
			ownerRepo: "o/r",
			host: "github.com",
		});

		expect(id?.github_login).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches from GitHub on cache miss + persists row", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				author: {
					login: "bob",
					avatar_url: "https://avatars/bob.png",
					html_url: "https://github.com/bob",
				},
			}),
		);

		const id = await svc.resolve("bob@y.com", {
			commitSha: "deadbeef",
			ownerRepo: "x/y",
			host: "github.com",
		});

		expect(id?.github_login).toBe("bob");
		expect(id?.avatar_url).toMatch(/avatars/);
		expect(fakePrisma.$executeRawUnsafe).toHaveBeenCalled();
		expect(cache.get("bob@y.com")?.github_login).toBe("bob");
	});

	it("does not fetch when host is not github.com", async () => {
		const id = await svc.resolve("u@gitlab.io", {
			commitSha: "sha",
			ownerRepo: "g/p",
			host: "gitlab.com",
		});
		expect(id).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not fetch without commitSha or ownerRepo", async () => {
		const id = await svc.resolve("u@x.com", { host: "github.com" });
		expect(id).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("writes negative cache row on 404", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 404,
			headers: new Headers(),
			json: async () => ({}),
		});

		await svc.resolve("missing@x.com", {
			commitSha: "sha",
			ownerRepo: "x/y",
			host: "github.com",
		});

		const cached = cache.get("missing@x.com");
		expect(cached).toBeDefined();
		expect(cached?.github_login).toBeNull();
		expect(cached?.source).toBe("commit-api-miss");
	});

	it("arms rate-limit halt when remaining<5; suppresses subsequent fetches", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "x-ratelimit-remaining": "2" }),
			json: async () => ({
				author: {
					login: "near-limit",
					avatar_url: "x",
					html_url: "x",
				},
			}),
		});

		await svc.resolve("nl@x.com", {
			commitSha: "sha",
			ownerRepo: "x/y",
			host: "github.com",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Subsequent resolve for a different email — fetch should NOT happen
		// because the halt window is armed.
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				author: { login: "should-not-fetch", avatar_url: "x", html_url: "x" },
			}),
		);
		const second = await svc.resolve("other@x.com", {
			commitSha: "sha2",
			ownerRepo: "x/y",
			host: "github.com",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second).toBeNull();
	});

	it("sends Authorization header when GITHUB_TOKEN is set", async () => {
		const original = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "test-token-123";
		try {
			fetchMock.mockResolvedValue(
				jsonResponse({
					author: {
						login: "alice",
						avatar_url: "x",
						html_url: "x",
					},
				}),
			);

			await svc.resolve("alice@x.com", {
				commitSha: "sha",
				ownerRepo: "x/y",
				host: "github.com",
			});

			const [_url, init] = fetchMock.mock.calls[0];
			expect(init.headers.Authorization).toBe("Bearer test-token-123");
		} finally {
			if (original === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = original;
		}
	});

	it("survives GitHub fetch network error (returns null, no cache write)", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNRESET"));
		const id = await svc.resolve("netfail@x.com", {
			commitSha: "sha",
			ownerRepo: "x/y",
			host: "github.com",
		});
		expect(id).toBeNull();
		expect(cache.has("netfail@x.com")).toBe(false);
	});
});
