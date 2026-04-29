import { ClickUpDirectService } from "./clickup-direct.service";
import { ClickUpRateLimiter } from "./rate-limiter";

/**
 * Tests for the request-with-retry path in ClickUpDirectService. We mock
 * global fetch to feed deterministic sequences of responses, then assert
 * the client's behavior across retry-eligible (5xx, 429) and terminal
 * (4xx) status codes.
 */
describe("ClickUpDirectService retry/limiter behaviour", () => {
	let svc: ClickUpDirectService;
	let lim: ClickUpRateLimiter;
	const realFetch = global.fetch;

	beforeEach(() => {
		process.env.CLICKUP_RATE_LIMIT_PER_MIN = "600"; // 10/sec — fast tests
		lim = new ClickUpRateLimiter();
		svc = new ClickUpDirectService(lim);
	});

	afterEach(() => {
		global.fetch = realFetch;
	});

	type MockResponse = {
		status?: number;
		body?: string;
		headers?: Record<string, string>;
	};
	function mockResponses(...responses: MockResponse[]) {
		let i = 0;
		global.fetch = jest.fn(async () => {
			const r = responses[Math.min(i++, responses.length - 1)];
			const body = r.body ?? "";
			const headers = new Headers(r.headers ?? {});
			return {
				ok: (r.status ?? 200) < 400,
				status: r.status ?? 200,
				headers,
				text: async () => body,
			} as Response;
		}) as unknown as typeof fetch;
	}

	it("returns parsed JSON on a 2xx response", async () => {
		mockResponses({
			status: 200,
			body: JSON.stringify({ spaces: [{ id: "s1", name: "X" }] }),
		});
		const out = await svc.listSpaces("team1", "tok");
		expect(out).toEqual([{ id: "s1", name: "X" }]);
	});

	it("retries on 5xx then succeeds", async () => {
		mockResponses(
			{ status: 500, body: "transient" },
			{ status: 502, body: "still transient" },
			{ status: 200, body: JSON.stringify({ id: "s2", name: "Y" }) },
		);
		// Use a mutating call so it goes through the limiter too.
		const out = await svc.createSpace("team1", "Y", "tok");
		expect(out).toEqual({ id: "s2", name: "Y" });
		expect(global.fetch).toHaveBeenCalledTimes(3);
	});

	it("does NOT retry on 400 (client error)", async () => {
		mockResponses({ status: 400, body: "bad request" });
		await expect(svc.createSpace("team1", "Z", "tok")).rejects.toThrow(/400/);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it("retries on 429, honouring X-RateLimit-Reset", async () => {
		const resetEpoch = Math.floor(Date.now() / 1000); // already-elapsed epoch — 0-ish wait
		mockResponses(
			{
				status: 429,
				body: "rate limited",
				headers: { "x-ratelimit-reset": String(resetEpoch) },
			},
			{ status: 200, body: JSON.stringify({ id: "f1", name: "F" }) },
		);
		const out = await svc.createFolder("space1", "F", "tok");
		expect(out).toEqual({ id: "f1", name: "F" });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it("throws after exhausting 5xx retries", async () => {
		// 6 responses (1 initial + 5 retries) all 503.
		mockResponses(
			{ status: 503, body: "down" },
			{ status: 503, body: "down" },
			{ status: 503, body: "down" },
			{ status: 503, body: "down" },
			{ status: 503, body: "down" },
			{ status: 503, body: "down" },
		);
		await expect(svc.createFolder("space1", "F", "tok")).rejects.toThrow(
			/upstream 503/,
		);
	}, 60_000);

	it("throws UnauthorizedException on 401", async () => {
		mockResponses({ status: 401, body: "bad token" });
		await expect(svc.listSpaces("team1", "tok")).rejects.toThrow(
			/rejected the token/,
		);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it("translates markdown_description → markdown_content on createTask body", async () => {
		let observedBody: unknown;
		global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
			observedBody = init?.body ? JSON.parse(init.body as string) : undefined;
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => JSON.stringify({ id: "t1", name: "n" }),
			} as Response;
		}) as unknown as typeof fetch;

		await svc.createTask(
			"list1",
			{ name: "n", markdown_description: "legacy field" },
			"tok",
		);
		expect(observedBody).toMatchObject({
			name: "n",
			markdown_content: "legacy field",
		});
		expect(observedBody).not.toHaveProperty("markdown_description");
	});

	it("prefers markdown_content when both fields are sent", async () => {
		let observedBody: unknown;
		global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
			observedBody = init?.body ? JSON.parse(init.body as string) : undefined;
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => JSON.stringify({ id: "t2", name: "n" }),
			} as Response;
		}) as unknown as typeof fetch;

		await svc.createTask(
			"list1",
			{ name: "n", markdown_content: "new", markdown_description: "old" },
			"tok",
		);
		expect(observedBody).toMatchObject({ markdown_content: "new" });
		expect(observedBody).not.toHaveProperty("markdown_description");
	});

	it("listDocPages handles the v3 array-shaped response (current ClickUp behaviour)", async () => {
		const pages = [
			{ id: "p1", name: "Overview" },
			{ id: "p2", name: "Changelog", parent_page_id: null },
		];
		mockResponses({ status: 200, body: JSON.stringify(pages) });
		const out = await svc.listDocPages("ws1", "doc1", "tok");
		expect(out).toEqual(pages);
	});

	it("listDocPages also tolerates a {pages: [...]} wrapped response", async () => {
		const pages = [{ id: "p3", name: "Setup" }];
		mockResponses({ status: 200, body: JSON.stringify({ pages }) });
		const out = await svc.listDocPages("ws1", "doc1", "tok");
		expect(out).toEqual(pages);
	});

	it("uses the v3 base URL for moveTaskToList", async () => {
		let observedUrl: string | undefined;
		global.fetch = jest.fn(async (url: unknown) => {
			observedUrl = String(url);
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => "",
			} as Response;
		}) as unknown as typeof fetch;

		await svc.moveTaskToList("ws1", "task1", "list2", "tok");
		expect(observedUrl).toContain("/api/v3/");
		expect(observedUrl).toContain(
			"/workspaces/ws1/tasks/task1/home_list/list2",
		);
	});
});
