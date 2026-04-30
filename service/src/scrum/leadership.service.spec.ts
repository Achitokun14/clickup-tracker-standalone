import { LeadershipService, hashTo32 } from "./leadership.service";

class FakeTx {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	constructor(private nextLockResult: boolean) {}
	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		if (sql.includes("pg_try_advisory_xact_lock")) {
			return [{ lock: this.nextLockResult }] as unknown as T;
		}
		return [] as unknown as T;
	}
}

class FakePrisma {
	constructor(private nextLockResult: boolean) {}

	async $transaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
		const tx = new FakeTx(this.nextLockResult);
		return fn(tx);
	}
}

describe("LeadershipService", () => {
	it("invokes fn when pg_try_advisory_xact_lock returns true", async () => {
		const svc = new LeadershipService(new FakePrisma(true) as any);
		let ran = false;
		const result = await svc.withLeadership("TEAM1", "scrum:plan", async () => {
			ran = true;
			return 42;
		});
		expect(ran).toBe(true);
		expect(result).toEqual({ leader: true, value: 42 });
	});

	it("does NOT invoke fn when lock acquisition fails", async () => {
		const svc = new LeadershipService(new FakePrisma(false) as any);
		let ran = false;
		const result = await svc.withLeadership("TEAM1", "scrum:plan", async () => {
			ran = true;
			return 42;
		});
		expect(ran).toBe(false);
		expect(result).toEqual({ leader: false, reason: "not_leader" });
	});
});

describe("hashTo32", () => {
	it("is deterministic", () => {
		expect(hashTo32("TEAM1")).toBe(hashTo32("TEAM1"));
	});
	it("produces different values for different inputs (probabilistic)", () => {
		expect(hashTo32("TEAM1")).not.toBe(hashTo32("TEAM2"));
	});
	it("returns a valid signed 32-bit integer", () => {
		const v = hashTo32("TEAM1");
		expect(Number.isInteger(v)).toBe(true);
		expect(v).toBeGreaterThanOrEqual(-(2 ** 31));
		expect(v).toBeLessThanOrEqual(2 ** 31 - 1);
	});
});
