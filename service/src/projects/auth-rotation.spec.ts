import { ProjectsService } from "./projects.service";

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	currentStatus: string | null = "auth-needed";
	rowExists = true;

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("UPDATE clickup_tracker.projects")) {
			// The "clearAuthNeeded" UPDATE — only flips when status='auth-needed'.
			if (this.currentStatus === "auth-needed") {
				this.currentStatus = "active";
				return [{ status: "active" }] as unknown as T;
			}
			return [] as unknown as T;
		}
		if (
			trimmed.startsWith("SELECT status FROM clickup_tracker.projects") &&
			this.rowExists
		) {
			return [{ status: this.currentStatus ?? "missing" }] as unknown as T;
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ..._params: unknown[]): Promise<number> {
		this.calls.push({ sql, params: _params });
		if (
			sql.includes("status = 'auth-needed'") &&
			this.currentStatus === "active"
		) {
			this.currentStatus = "auth-needed";
			return 1;
		}
		return 0;
	}
}

function build() {
	const prisma = new FakePrisma();
	const svc = new ProjectsService(
		prisma as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
	);
	return { prisma, svc };
}

describe("ProjectsService — auth-needed state machine (Plan §B.6)", () => {
	const ORG = "00000000-0000-0000-0000-000000000abc";
	const PROJ = "11111111-1111-1111-1111-111111111111";

	it("clearAuthNeeded flips status='auth-needed' → 'active'", async () => {
		const { svc, prisma } = build();
		const r = await svc.clearAuthNeeded(ORG, PROJ);
		expect(r.flipped).toBe(true);
		expect(r.status).toBe("active");
		expect(prisma.currentStatus).toBe("active");
	});

	it("clearAuthNeeded is a no-op when status is already 'active'", async () => {
		const { svc, prisma } = build();
		prisma.currentStatus = "active";
		const r = await svc.clearAuthNeeded(ORG, PROJ);
		expect(r.flipped).toBe(false);
		expect(r.status).toBe("active");
	});

	it("clearAuthNeeded returns 'missing' when project not found", async () => {
		const { svc, prisma } = build();
		prisma.currentStatus = "active";
		prisma.rowExists = false;
		const r = await svc.clearAuthNeeded(ORG, PROJ);
		expect(r.flipped).toBe(false);
		expect(r.status).toBe("missing");
	});

	it("flipToAuthNeeded flips status='active' → 'auth-needed' (idempotent)", async () => {
		const { svc, prisma } = build();
		prisma.currentStatus = "active";
		await svc.flipToAuthNeeded(PROJ, "test 401");
		expect(prisma.currentStatus).toBe("auth-needed");
		// Re-flipping is a silent no-op (no error, no change).
		await svc.flipToAuthNeeded(PROJ, "test 401");
		expect(prisma.currentStatus).toBe("auth-needed");
	});
});
