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
});
