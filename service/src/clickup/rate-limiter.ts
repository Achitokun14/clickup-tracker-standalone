import { Injectable, Logger } from "@nestjs/common";

/**
 * Token-bucket rate limiter for ClickUp API mutations. One bucket per token
 * (a ClickUp personal/OAuth token is the rate-limit unit). GET requests
 * bypass the limiter; mutations (POST/PUT/DELETE) call acquire() before
 * issuing the HTTP request.
 *
 * Default 90 requests per 60s — 10% headroom under ClickUp's 100/min ceiling
 * on the Free/Unlimited/Business tiers. Override via CLICKUP_RATE_LIMIT_PER_MIN.
 *
 * Implementation: refill-on-demand. Whenever acquire() is called, we credit
 * the bucket with (now - lastRefillMs) * (capacityPerWindow / windowMs)
 * tokens, capped at capacity. If at least 1 token is available, consume it
 * and return immediately. Otherwise sleep just long enough for one token to
 * become available, then consume.
 *
 * In-house by design — see CARL rule #2 for CLICKUP_TRACKER_REWRITE.
 */
@Injectable()
export class ClickUpRateLimiter {
	private readonly log = new Logger(ClickUpRateLimiter.name);
	private readonly capacity: number;
	private readonly windowMs = 60_000;
	private readonly buckets = new Map<
		string,
		{ tokens: number; lastRefillMs: number }
	>();

	constructor() {
		const envVal = parseInt(
			process.env.CLICKUP_RATE_LIMIT_PER_MIN ||
				process.env.CLICKUP_RATE_LIMIT ||
				"90",
			10,
		);
		this.capacity = Number.isFinite(envVal) && envVal > 0 ? envVal : 90;
		this.log.log(
			`ClickUp rate limiter: ${this.capacity} requests per ${this.windowMs / 1000}s per token`,
		);
	}

	/**
	 * Block until at least one token is available for `tokenKey`, then consume
	 * it. Returns the number of milliseconds the caller was throttled (0 if
	 * the call passed without waiting).
	 */
	async acquire(tokenKey: string): Promise<number> {
		const startMs = Date.now();
		while (true) {
			const bucket = this.refill(tokenKey, Date.now());
			if (bucket.tokens >= 1) {
				bucket.tokens -= 1;
				return Date.now() - startMs;
			}
			// How long until the bucket has 1 token? token-rate = capacity / windowMs per ms
			const tokensNeeded = 1 - bucket.tokens;
			const msPerToken = this.windowMs / this.capacity;
			const waitMs = Math.max(50, Math.ceil(tokensNeeded * msPerToken));
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}

	/**
	 * Honour an explicit reset epoch from a 429 response's X-RateLimit-Reset
	 * header. Drains the bucket to zero and pushes lastRefillMs to the reset
	 * time, so the next acquire() will sleep until the server says it's safe.
	 */
	forceWaitUntil(tokenKey: string, resetEpochSeconds: number): void {
		const targetMs = resetEpochSeconds * 1000;
		const bucket = this.refill(tokenKey, Date.now());
		bucket.tokens = 0;
		bucket.lastRefillMs = Math.max(bucket.lastRefillMs, targetMs);
	}

	/** Test/observability hook — current credits for a token. */
	remaining(tokenKey: string): number {
		const bucket = this.refill(tokenKey, Date.now());
		return Math.floor(bucket.tokens);
	}

	private refill(
		tokenKey: string,
		nowMs: number,
	): { tokens: number; lastRefillMs: number } {
		let bucket = this.buckets.get(tokenKey);
		if (!bucket) {
			bucket = { tokens: this.capacity, lastRefillMs: nowMs };
			this.buckets.set(tokenKey, bucket);
			return bucket;
		}
		const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
		if (elapsed === 0) return bucket;
		const refillTokens = (elapsed / this.windowMs) * this.capacity;
		bucket.tokens = Math.min(this.capacity, bucket.tokens + refillTokens);
		bucket.lastRefillMs = nowMs;
		return bucket;
	}
}

/**
 * Stable-ish bucket key derived from a ClickUp token. Strips bearer prefix
 * and uses the first 16 chars + length as a fingerprint so we don't keep the
 * full token as a Map key. Sufficient for in-process dedup; not a security
 * measure.
 */
export function bucketKeyForToken(token: string): string {
	const t = token.replace(/^Bearer\s+/i, "");
	return `${t.length}:${t.slice(0, 16)}`;
}
