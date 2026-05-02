import { staleness } from "./railway-poll.cron";

describe("staleness", () => {
	it("returns 24h ago when no prior poll", () => {
		const now = Date.now();
		const out = staleness(null).getTime();
		expect(out).toBeLessThanOrEqual(now - 24 * 3600 * 1000 + 1000);
		expect(out).toBeGreaterThanOrEqual(now - 24 * 3600 * 1000 - 1000);
	});
	it("returns 60s before the last poll for overlap safety", () => {
		const last = new Date("2026-05-02T10:14:00Z");
		const out = staleness(last);
		expect(out.toISOString()).toBe("2026-05-02T10:13:00.000Z");
	});
});
