import { AuditService } from "./audit.service";

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	rows: any[] = [];

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push({ sql, params });
		this.rows.push({
			project_id: params[0],
			kind: params[1],
			target: params[2],
			before: params[3],
			after: params[4],
			reason: params[5],
			dry_run: params[6],
		});
		return 1;
	}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		return this.rows as unknown as T;
	}
}

function build() {
	const prisma = new FakePrisma();
	return { svc: new AuditService(prisma as any), prisma };
}

describe("AuditService", () => {
	it("record() inserts a JSONB-serialised row", async () => {
		const { svc, prisma } = build();
		await svc.record({
			projectId: "11111111-1111-1111-1111-111111111111",
			kind: "plan_sprint",
			target: "LIST_X",
			before: { foo: 1 },
			after: { foo: 2, bar: "baz" },
			reason: "test",
			dryRun: false,
		});
		expect(prisma.rows).toHaveLength(1);
		expect(prisma.rows[0]).toMatchObject({
			kind: "plan_sprint",
			target: "LIST_X",
			reason: "test",
			dry_run: false,
		});
		// JSONB before/after are stringified
		expect(typeof prisma.rows[0].before).toBe("string");
		expect(JSON.parse(prisma.rows[0].before).foo).toBe(1);
	});

	it("record() leaves before/after null when omitted", async () => {
		const { svc, prisma } = build();
		await svc.record({
			projectId: "11111111-1111-1111-1111-111111111111",
			kind: "groom",
			reason: "no work",
		});
		expect(prisma.rows[0].before).toBeNull();
		expect(prisma.rows[0].after).toBeNull();
	});

	it("record() never throws even if the INSERT fails", async () => {
		const { svc, prisma } = build();
		(prisma as any).$executeRawUnsafe = async () => {
			throw new Error("simulated DB outage");
		};
		await expect(
			svc.record({
				projectId: "11111111-1111-1111-1111-111111111111",
				kind: "plan_sprint",
				reason: "test",
			}),
		).resolves.toBeUndefined();
	});

	it("list() builds a parameterised SELECT honouring since/kind/limit", async () => {
		const { svc, prisma } = build();
		// Pre-seed a row so the query path is exercised.
		await svc.record({
			projectId: "11111111-1111-1111-1111-111111111111",
			kind: "plan_sprint",
			reason: "test",
		});
		const out = await svc.list("11111111-1111-1111-1111-111111111111", {
			since: "2026-04-29T00:00:00Z",
			kind: "plan_sprint",
			limit: 50,
		});
		expect(out).toHaveLength(1);
		// Last call should be the SELECT
		const last = prisma.calls[prisma.calls.length - 1];
		expect(last.sql).toContain("FROM clickup_tracker.scrum_audit");
		expect(last.params).toContain("plan_sprint");
		expect(last.params).toContain("2026-04-29T00:00:00Z");
		expect(last.params).toContain(50);
	});
});
