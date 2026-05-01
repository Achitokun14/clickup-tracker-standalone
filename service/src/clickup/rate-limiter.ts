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
 * Plan §C.8 — three-tier priority queueing. `urgent` > `normal` > `scrum`.
 *   - Lifecycle handlers + user-triggered endpoints → `urgent`/`normal`.
 *   - Backfill orchestration → `normal`.
 *   - Autonomous SCRUM crons (planner, groomer, reporting) → `scrum`.
 *
 * Strict priority: while ANY higher-priority waiter is queued, lower-priority
 * acquires block, even if a token is available. This guarantees that a
 * groom/standup cron under load never starves an inbound user mutation.
 *
 * In-house by design — see CARL rule #2 for CLICKUP_TRACKER_REWRITE.
 */

export type LimitPriority = "urgent" | "normal" | "scrum";

const PRIORITY_ORDER: LimitPriority[] = ["urgent", "normal", "scrum"];

interface Bucket {
	tokens: number;
	lastRefillMs: number;
}

interface Waiter {
	priority: LimitPriority;
	enqueuedAt: number;
	resolve: () => void;
}

interface QueueLanes {
	urgent: Waiter[];
	normal: Waiter[];
	scrum: Waiter[];
}

@Injectable()
export class ClickUpRateLimiter {
	private readonly log = new Logger(ClickUpRateLimiter.name);
	private readonly capacity: number;
	private readonly windowMs = 60_000;
	private readonly buckets = new Map<string, Bucket>();
	private readonly queues = new Map<string, QueueLanes>();
	private readonly pendingWakes = new Map<string, NodeJS.Timeout>();

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
	 * Block until at least one token is available for `tokenKey` AND no
	 * higher-priority waiter is queued ahead of us, then consume the
	 * token. Returns the number of milliseconds the caller was throttled
	 * (0 if the call passed without waiting).
	 */
	async acquire(
		tokenKey: string,
		priority: LimitPriority = "normal",
	): Promise<number> {
		const startMs = Date.now();
		const queues = this.getQueues(tokenKey);
		const bucket = this.refill(tokenKey, startMs);

		// Fast path: token available AND no higher-priority waiter ahead.
		if (bucket.tokens >= 1 && !this.hasHigherPriorityWaiter(queues, priority)) {
			bucket.tokens -= 1;
			return 0;
		}

		// Slow path: enqueue + wait. The drain loop will resolve us in
		// priority order whenever a token becomes available.
		await new Promise<void>((resolve) => {
			queues[priority].push({
				priority,
				enqueuedAt: startMs,
				resolve,
			});
			this.scheduleWake(tokenKey);
		});
		return Date.now() - startMs;
	}

	/**
	 * Honour an explicit reset epoch from a 429 response's X-RateLimit-Reset
	 * header. Drains the bucket to zero and pushes lastRefillMs to the reset
	 * time, so the next acquire() will sleep until the server says it's safe.
	 * Reschedules the wake timer so queued waiters wake at the new time.
	 */
	forceWaitUntil(tokenKey: string, resetEpochSeconds: number): void {
		const targetMs = resetEpochSeconds * 1000;
		const bucket = this.refill(tokenKey, Date.now());
		bucket.tokens = 0;
		bucket.lastRefillMs = Math.max(bucket.lastRefillMs, targetMs);
		// If we have queued waiters, the existing pending wake may fire too
		// soon (before targetMs). Cancel + reschedule against the new floor.
		const handle = this.pendingWakes.get(tokenKey);
		if (handle) {
			clearTimeout(handle);
			this.pendingWakes.delete(tokenKey);
		}
		if (this.hasAnyWaiter(this.getQueues(tokenKey))) {
			this.scheduleWake(tokenKey);
		}
	}

	/** Test/observability hook — current credits for a token. */
	remaining(tokenKey: string): number {
		const bucket = this.refill(tokenKey, Date.now());
		return Math.floor(bucket.tokens);
	}

	/** Test/observability hook — queued waiter counts per priority. */
	queueDepth(tokenKey: string): {
		urgent: number;
		normal: number;
		scrum: number;
	} {
		const q = this.queues.get(tokenKey);
		return {
			urgent: q?.urgent.length ?? 0,
			normal: q?.normal.length ?? 0,
			scrum: q?.scrum.length ?? 0,
		};
	}

	private getQueues(tokenKey: string): QueueLanes {
		let q = this.queues.get(tokenKey);
		if (!q) {
			q = { urgent: [], normal: [], scrum: [] };
			this.queues.set(tokenKey, q);
		}
		return q;
	}

	private hasHigherPriorityWaiter(
		queues: QueueLanes,
		priority: LimitPriority,
	): boolean {
		const idx = PRIORITY_ORDER.indexOf(priority);
		for (let i = 0; i < idx; i++) {
			if (queues[PRIORITY_ORDER[i]].length > 0) return true;
		}
		return false;
	}

	private hasAnyWaiter(q: QueueLanes): boolean {
		return q.urgent.length + q.normal.length + q.scrum.length > 0;
	}

	private nextWaiter(q: QueueLanes): Waiter | undefined {
		for (const p of PRIORITY_ORDER) {
			const w = q[p].shift();
			if (w) return w;
		}
		return undefined;
	}

	private scheduleWake(tokenKey: string): void {
		if (this.pendingWakes.has(tokenKey)) return;
		const bucket = this.refill(tokenKey, Date.now());
		const tokensNeeded = Math.max(0, 1 - bucket.tokens);
		const msPerToken = this.windowMs / this.capacity;
		const waitMs =
			tokensNeeded === 0
				? 0
				: Math.max(50, Math.ceil(tokensNeeded * msPerToken));
		const handle = setTimeout(() => {
			this.pendingWakes.delete(tokenKey);
			this.drain(tokenKey);
		}, waitMs);
		// Allow Node to exit while a wake is pending (don't keep the event
		// loop alive solely for queued requests).
		if (typeof (handle as any).unref === "function") (handle as any).unref();
		this.pendingWakes.set(tokenKey, handle);
	}

	private drain(tokenKey: string): void {
		const queues = this.getQueues(tokenKey);
		while (true) {
			const bucket = this.refill(tokenKey, Date.now());
			if (bucket.tokens < 1) {
				if (this.hasAnyWaiter(queues)) this.scheduleWake(tokenKey);
				return;
			}
			const next = this.nextWaiter(queues);
			if (!next) return;
			bucket.tokens -= 1;
			next.resolve();
		}
	}

	private refill(tokenKey: string, nowMs: number): Bucket {
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
