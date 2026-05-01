import { HttpException } from "@nestjs/common";
import { OrphanDetectionCron } from "./orphan-detection.cron";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string;
	status?: string;
}

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	projects: FakeProjectRow[] = [];
	failFetch = false;
	statusUpdates: Record<string, string> = {};

	async $queryRawUnsafe<T>(sql: string, ..._params: unknown[]): Promise<T> {
		this.calls.push({ sql, params: _params });
		if (this.failFetch) throw new Error("db down");
		return this.projects.filter(
			(p) => (p.status ?? "active") === "active",
		) as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push({ sql, params });
		if (
			sql.includes("status = 'orphaned'") &&
			sql.includes("status = 'active'")
		) {
			const id = String(params[0]);
			const proj = this.projects.find((p) => p.id === id);
			if (proj && (proj.status ?? "active") === "active") {
				proj.status = "orphaned";
				this.statusUpdates[id] = "orphaned";
				return 1;
			}
		}
		return 0;
	}
}

class FakeCredentials {
	failOnOrg: string | null = null;
	async forOrg(orgId: string) {
		if (this.failOnOrg === orgId) {
			throw new Error("no credentials");
		}
		return { team_id: "TEAM1", token: `pk_${orgId}` };
	}
}

class FakeClickUp {
	calls: Array<{ method: string; args: unknown[] }> = [];
	responses = new Map<string, "ok" | "404" | "500" | "401">();

	async getSpace(spaceId: string, _token: string) {
		this.calls.push({ method: "getSpace", args: [spaceId] });
		const r = this.responses.get(spaceId) ?? "ok";
		if (r === "ok") return { id: spaceId, name: "Sample" };
		if (r === "404") {
			throw new HttpException(`ClickUp v2 GET /space/${spaceId} → 404`, 404);
		}
		if (r === "401") {
			throw new HttpException(`ClickUp v2 GET /space/${spaceId} → 401`, 401);
		}
		throw new HttpException(`ClickUp v2 GET /space/${spaceId} → 500`, 500);
	}
}

function build() {
	const prisma = new FakePrisma();
	const creds = new FakeCredentials();
	const cu = new FakeClickUp();
	const cron = new OrphanDetectionCron(prisma as any, creds as any, cu as any);
	return { cron, prisma, creds, cu };
}

const baseProject: FakeProjectRow = {
	id: "11111111-1111-1111-1111-111111111111",
	organisation_id: "22222222-2222-2222-2222-222222222222",
	display_name: "Sample",
	clickup_team_id: "TEAM1",
	clickup_space_id: "SPACE1",
	status: "active",
};

describe("OrphanDetectionCron (Plan §B.8)", () => {
	it("on 404 → flips status to 'orphaned'", async () => {
		const { cron, prisma, cu } = build();
		prisma.projects = [{ ...baseProject }];
		cu.responses.set("SPACE1", "404");
		const result = await cron.probeOne(prisma.projects[0]);
		expect(result).toBe("orphaned");
		expect(prisma.statusUpdates[baseProject.id]).toBe("orphaned");
	});

	it("on 200 → leaves status as 'active'", async () => {
		const { cron, prisma } = build();
		prisma.projects = [{ ...baseProject }];
		const result = await cron.probeOne(prisma.projects[0]);
		expect(result).toBe("ok");
		expect(prisma.statusUpdates[baseProject.id]).toBeUndefined();
		expect(prisma.projects[0].status).toBe("active");
	});

	it("on 401/5xx → returns skipped without flipping status", async () => {
		for (const code of ["401", "500"] as const) {
			const { cron, prisma, cu } = build();
			prisma.projects = [{ ...baseProject }];
			cu.responses.set("SPACE1", code);
			const result = await cron.probeOne(prisma.projects[0]);
			expect(result).toBe("skipped");
			expect(prisma.statusUpdates[baseProject.id]).toBeUndefined();
		}
	});

	it("missing credentials → skipped (no API call attempted)", async () => {
		const { cron, prisma, creds, cu } = build();
		prisma.projects = [{ ...baseProject }];
		creds.failOnOrg = baseProject.organisation_id;
		const result = await cron.probeOne(prisma.projects[0]);
		expect(result).toBe("skipped");
		expect(cu.calls.length).toBe(0);
	});

	it("tick() probes every active project with a non-null space_id", async () => {
		const { cron, prisma, cu } = build();
		prisma.projects = [
			{ ...baseProject, id: "p1", clickup_space_id: "S1" },
			{
				...baseProject,
				id: "p2",
				clickup_space_id: "S2",
				organisation_id: "org-2",
			},
		];
		cu.responses.set("S1", "ok");
		cu.responses.set("S2", "404");
		await cron.tick();
		const probedIds = cu.calls
			.filter((c) => c.method === "getSpace")
			.map((c) => (c.args as any[])[0]);
		expect(probedIds.sort()).toEqual(["S1", "S2"]);
		expect(prisma.statusUpdates["p2"]).toBe("orphaned");
		expect(prisma.statusUpdates["p1"]).toBeUndefined();
	});

	it("CUP_ORPHAN_DETECTION=off bypasses the tick entirely", async () => {
		const { cron, prisma, cu } = build();
		prisma.projects = [{ ...baseProject }];
		const prev = process.env.CUP_ORPHAN_DETECTION;
		process.env.CUP_ORPHAN_DETECTION = "off";
		try {
			await cron.tick();
			expect(cu.calls.length).toBe(0);
			expect(prisma.calls.length).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.CUP_ORPHAN_DETECTION;
			else process.env.CUP_ORPHAN_DETECTION = prev;
		}
	});

	it("re-flipping an already-orphaned project is a no-op", async () => {
		const { cron, prisma, cu } = build();
		prisma.projects = [{ ...baseProject, status: "orphaned" }];
		// fetchProbeable filters status='active', so tick() won't touch it.
		cu.responses.set("SPACE1", "404");
		await cron.tick();
		expect(cu.calls.length).toBe(0);
	});

	it("DB query failure on fetchProbeable → tick is a silent no-op", async () => {
		const { cron, prisma, cu } = build();
		prisma.failFetch = true;
		await expect(cron.tick()).resolves.toBeUndefined();
		expect(cu.calls.length).toBe(0);
	});
});
