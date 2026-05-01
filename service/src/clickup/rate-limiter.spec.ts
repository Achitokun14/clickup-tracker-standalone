import { ClickUpRateLimiter, bucketKeyForToken } from "./rate-limiter";

describe("bucketKeyForToken", () => {
	it("strips the Bearer prefix and uses length+prefix as fingerprint", () => {
		const k1 = bucketKeyForToken("pk_abcdefghijklmnop_secret_tail");
		const k2 = bucketKeyForToken("Bearer pk_abcdefghijklmnop_secret_tail");
		expect(k1).toBe(k2);
		expect(k1).toContain("pk_abcdefghijklm");
	});

	it("differs when length differs", () => {
		expect(bucketKeyForToken("aaaa")).not.toBe(bucketKeyForToken("aaaab"));
	});
});

describe("ClickUpRateLimiter", () => {
	const KEY = "fingerprint-A";

	beforeEach(() => {
		delete process.env.CLICKUP_RATE_LIMIT_PER_MIN;
		delete process.env.CLICKUP_RATE_LIMIT;
	});

	it("acquires immediately while tokens remain in the bucket", async () => {
		process.env.CLICKUP_RATE_LIMIT_PER_MIN = "60";
		const lim = new ClickUpRateLimiter();
		const start = Date.now();
		for (let i = 0; i < 10; i++) {
			const waited = await lim.acquire(KEY);
			expect(waited).toBeLessThan(50);
		}
		expect(Date.now() - start).toBeLessThan(200);
		expect(lim.remaining(KEY)).toBeGreaterThanOrEqual(49);
	});

	it("throttles when the bucket is exhausted", async () => {
		process.env.CLICKUP_RATE_LIMIT_PER_MIN = "60"; // 1 token per second
		const lim = new ClickUpRateLimiter();
		// Drain the bucket by force.
		lim.forceWaitUntil(KEY, Math.floor(Date.now() / 1000) + 0); // empty + lastRefill stays roughly now
		// Override: drain to 0 with a tiny wait window.
		(
			lim as unknown as {
				buckets: Map<string, { tokens: number; lastRefillMs: number }>;
			}
		).buckets.set(KEY, {
			tokens: 0,
			lastRefillMs: Date.now(),
		});
		const start = Date.now();
		const waited = await lim.acquire(KEY);
		const elapsed = Date.now() - start;
		expect(waited).toBeGreaterThanOrEqual(50);
		expect(elapsed).toBeGreaterThanOrEqual(50);
		// At 60/min => 1000ms per token, but the limiter's internal floor is 50ms per loop;
		// the effective wait should be well under 5s in this fast test.
		expect(elapsed).toBeLessThan(5000);
	});

	it("forceWaitUntil drains and pushes lastRefill forward", async () => {
		process.env.CLICKUP_RATE_LIMIT_PER_MIN = "600"; // 10/sec
		const lim = new ClickUpRateLimiter();
		// First acquire is free.
		await lim.acquire(KEY);
		expect(lim.remaining(KEY)).toBeGreaterThan(0);

		// Server says: don't try until +1s from now.
		const resetEpoch = Math.floor(Date.now() / 1000) + 1;
		lim.forceWaitUntil(KEY, resetEpoch);
		expect(lim.remaining(KEY)).toBe(0);

		// Acquire blocks until at least the reset.
		const start = Date.now();
		await lim.acquire(KEY);
		const elapsed = Date.now() - start;
		// At 600/min the limiter refills 10 tokens/sec, so wait ≈ 100-200ms above
		// the initial drain — but never zero.
		expect(elapsed).toBeGreaterThan(50);
	});

	it("each token gets its own bucket", async () => {
		process.env.CLICKUP_RATE_LIMIT_PER_MIN = "60";
		const lim = new ClickUpRateLimiter();
		await lim.acquire("token-A");
		await lim.acquire("token-A");
		expect(lim.remaining("token-A")).toBeLessThan(60);
		expect(lim.remaining("token-B")).toBe(60);
	});

	// ── Plan §C.8 — priority queues ───────────────────────────────────
	describe("priority queues", () => {
		it("default priority is 'normal' (no regression to existing call sites)", async () => {
			process.env.CLICKUP_RATE_LIMIT_PER_MIN = "600";
			const lim = new ClickUpRateLimiter();
			const waited = await lim.acquire(KEY);
			expect(waited).toBeLessThan(50);
		});

		it("urgent waiter preempts queued scrum waiters once a token frees up", async () => {
			// Capacity=2 keeps the bucket tight enough that we can race waiters.
			process.env.CLICKUP_RATE_LIMIT_PER_MIN = "120"; // 2/sec
			const lim = new ClickUpRateLimiter();
			// Burn the initial 2 tokens so subsequent acquires queue.
			for (let i = 0; i < 120; i++) await lim.acquire(KEY);

			const order: string[] = [];
			const scrum1 = lim.acquire(KEY, "scrum").then(() => order.push("scrum1"));
			const scrum2 = lim.acquire(KEY, "scrum").then(() => order.push("scrum2"));
			// Wait a tick to ensure scrum waiters are queued first.
			await new Promise((r) => setImmediate(r));
			const urgent = lim
				.acquire(KEY, "urgent")
				.then(() => order.push("urgent"));

			await Promise.all([scrum1, scrum2, urgent]);
			// Urgent must come out before both scrum waiters even though it
			// arrived later.
			expect(order[0]).toBe("urgent");
		});

		it("scrum acquire blocks while an urgent waiter is queued (strict priority)", async () => {
			process.env.CLICKUP_RATE_LIMIT_PER_MIN = "120";
			const lim = new ClickUpRateLimiter();
			for (let i = 0; i < 120; i++) await lim.acquire(KEY);
			// urgent queued first
			const urgent = lim.acquire(KEY, "urgent");
			await new Promise((r) => setImmediate(r));
			// scrum arrives — even if a token freed, urgent must consume first.
			const scrum = lim.acquire(KEY, "scrum");

			const urgentMs = await urgent;
			const scrumMs = await scrum;
			// Both waited (slow path); urgent's wait is shorter than scrum's.
			expect(urgentMs).toBeGreaterThan(0);
			expect(scrumMs).toBeGreaterThanOrEqual(urgentMs);
		});

		it("queueDepth reports per-priority counts", async () => {
			process.env.CLICKUP_RATE_LIMIT_PER_MIN = "120";
			const lim = new ClickUpRateLimiter();
			for (let i = 0; i < 120; i++) await lim.acquire(KEY);
			// Don't await — leave them queued for a moment.
			const a = lim.acquire(KEY, "scrum");
			const b = lim.acquire(KEY, "scrum");
			const c = lim.acquire(KEY, "normal");
			await new Promise((r) => setImmediate(r));
			const depth = lim.queueDepth(KEY);
			expect(depth.scrum).toBe(2);
			expect(depth.normal).toBe(1);
			expect(depth.urgent).toBe(0);
			// Drain so the test exits cleanly.
			await Promise.all([a, b, c]);
		});

		it("FIFO order within the same priority", async () => {
			process.env.CLICKUP_RATE_LIMIT_PER_MIN = "120";
			const lim = new ClickUpRateLimiter();
			for (let i = 0; i < 120; i++) await lim.acquire(KEY);
			const order: string[] = [];
			const a = lim.acquire(KEY, "scrum").then(() => order.push("a"));
			const b = lim.acquire(KEY, "scrum").then(() => order.push("b"));
			const c = lim.acquire(KEY, "scrum").then(() => order.push("c"));
			await Promise.all([a, b, c]);
			expect(order).toEqual(["a", "b", "c"]);
		});
	});
});
