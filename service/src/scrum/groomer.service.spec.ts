import { GroomerService, jaccard, tokenize } from "./groomer.service";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	last_groom_at: Date | null;
	scrum_config: Record<string, unknown> | null;
	status?: string;
}

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	hotspots: Array<{ path: string; n: number }> = [];
	hotspotEmittedPaths: string[] = [];

	constructor(private project: FakeProjectRow) {}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("SELECT id, organisation_id, clickup_team_id")) {
			return [this.project] as unknown as T;
		}
		if (sql.includes("jsonb_array_elements") && sql.includes("files_changed")) {
			return this.hotspots.map((h) => ({
				path: h.path,
				n: BigInt(h.n),
			})) as unknown as T;
		}
		if (sql.includes("kind = 'groom:hotspot_promote'")) {
			return this.hotspotEmittedPaths.includes(params[1] as string)
				? ([{ id: "AUDIT_X" }] as unknown as T)
				: ([] as unknown as T);
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ..._params: unknown[]): Promise<number> {
		this.calls.push({ sql, params: _params });
		if (sql.includes("last_groom_at = NOW()")) {
			this.project.last_groom_at = new Date();
		}
		return 1;
	}
}

class FakeCredentials {
	async forOrg() {
		return { team_id: "TEAM1", token: "pk_test" };
	}
}

class FakeClickUp {
	calls: Array<{ method: string; args: unknown[] }> = [];
	tasksByList: Map<string, any[]> = new Map();
	createdTasks: any[] = [];

	async listTasksInList(listId: string) {
		this.calls.push({ method: "listTasksInList", args: [listId] });
		return (this.tasksByList.get(listId) ?? []).map((t) => ({ ...t }));
	}
	async addTagToTask(taskId: string, tag: string) {
		this.calls.push({ method: "addTagToTask", args: [taskId, tag] });
	}
	async addComment(taskId: string, text: string) {
		this.calls.push({ method: "addComment", args: [taskId, text] });
	}
	async setTaskStatus(taskId: string, status: string) {
		this.calls.push({ method: "setTaskStatus", args: [taskId, status] });
	}
	async createTask(listId: string, body: { name: string }) {
		this.createdTasks.push({ listId, ...body });
		return { id: `T_NEW_${this.createdTasks.length}`, name: body.name };
	}
}

class FakeAudit {
	rows: any[] = [];
	async record(args: any) {
		this.rows.push(args);
	}
}

function build(project: FakeProjectRow) {
	const prisma = new FakePrisma(project);
	const creds = new FakeCredentials();
	const cu = new FakeClickUp();
	const audit = new FakeAudit();
	const svc = new GroomerService(
		prisma as any,
		creds as any,
		cu as any,
		audit as any,
	);
	return { svc, prisma, cu, audit };
}

const baseProject: FakeProjectRow = {
	id: "11111111-1111-1111-1111-111111111111",
	organisation_id: "22222222-2222-2222-2222-222222222222",
	clickup_team_id: "TEAM1",
	clickup_space_id: "SPACE1",
	list_ids: { open_work: "L_OW", bugs: "L_BUGS" },
	last_groom_at: null,
	scrum_config: {},
};

const dayMs = 24 * 60 * 60 * 1000;

describe("GroomerService.groom (Plan §C.2)", () => {
	it("dryRun=true returns plan WITHOUT mutations", async () => {
		const { svc, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_OW", [
			{
				id: "A",
				name: "[2026-04-29] Feature(api): add user auth flow",
				date_created: String(Date.now() - 10 * dayMs),
				status: { type: "open" },
			},
			{
				id: "B",
				name: "[2026-04-29] Feature(api): add user auth flow",
				date_created: String(Date.now() - 5 * dayMs),
				status: { type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", []);
		const plan = await svc.groom(baseProject.id, true);
		expect(plan.dryRun).toBe(true);
		expect(plan.dedupes.length).toBeGreaterThan(0);
		expect(plan.dedupes[0].olderId).toBe("A");
		expect(plan.dedupes[0].newerId).toBe("B");
		expect(cu.calls.some((c) => c.method === "addTagToTask")).toBe(false);
	});

	it("dryRun=false executes dedupe + stale-bug shame + persists last_groom_at", async () => {
		const { svc, prisma, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_OW", [
			{
				id: "A",
				name: "[2026-04-29] Feature(api): add login",
				date_created: String(Date.now() - 10 * dayMs),
				status: { type: "open" },
			},
			{
				id: "B",
				name: "[2026-04-29] Feature(api): add login",
				date_created: String(Date.now() - 5 * dayMs),
				status: { type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", [
			{
				id: "BUG_OLD",
				name: "[Bug] thirty-day-old bug",
				date_created: String(Date.now() - 35 * dayMs),
				status: { status: "Open", type: "open" },
			},
		]);
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.dedupes).toHaveLength(1);
		expect(plan.staleBugShames).toHaveLength(1);
		expect(
			cu.calls.find(
				(c) =>
					c.method === "addTagToTask" && (c.args as any[])[1] === "stale-bug",
			),
		).toBeDefined();
		expect(
			cu.calls.find(
				(c) =>
					c.method === "addTagToTask" &&
					/^duplicate-of:/.test((c.args as any[])[1]),
			),
		).toBeDefined();
		expect(
			prisma.calls.some((c) => c.sql.includes("last_groom_at = NOW()")),
		).toBe(true);
	});

	it("is idempotent within the same UTC day", async () => {
		const { svc, cu } = build({ ...baseProject, last_groom_at: new Date() });
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.skipped).toBe("already_groomed_today");
		expect(cu.calls.length).toBe(0);
	});

	it("hotspot promote creates a task and respects 30d cooldown", async () => {
		const { svc, prisma, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_OW", []);
		cu.tasksByList.set("L_BUGS", []);
		prisma.hotspots = [
			{ path: "src/api.ts", n: 5 },
			{ path: "src/web.ts", n: 4 },
		];
		// src/api.ts already promoted recently — skip
		prisma.hotspotEmittedPaths = ["src/api.ts"];
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.hotspots.map((h) => h.path)).toEqual(["src/web.ts"]);
		expect(cu.createdTasks).toHaveLength(1);
		expect(cu.createdTasks[0].name).toContain("[Hotspot]");
		expect(cu.createdTasks[0].name).toContain("src/web.ts");
	});

	it("hotspot is suppressed when an Open Work task already references the path", async () => {
		const { svc, prisma, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_OW", [
			{
				id: "T_REFD",
				name: "Audit src/api.ts perf",
				date_created: String(Date.now()),
				status: { type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", []);
		prisma.hotspots = [{ path: "src/api.ts", n: 5 }];
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.hotspots).toHaveLength(0);
	});

	it("zombie_archive defaults OFF (no archives even with idle tasks)", async () => {
		const { svc, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_OW", [
			{
				id: "Z1",
				name: "ancient task",
				date_created: String(Date.now() - 120 * dayMs),
				status: { status: "Backlog", type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", []);
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.zombies).toHaveLength(0);
	});

	it("zombie_archive opted-in archives + tags", async () => {
		const { svc, cu } = build({
			...baseProject,
			scrum_config: { groom: { zombie_archive: true } },
		});
		cu.tasksByList.set("L_OW", [
			{
				id: "Z1",
				name: "ancient task",
				date_created: String(Date.now() - 120 * dayMs),
				status: { status: "Backlog", type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", []);
		const plan = await svc.groom(baseProject.id, false);
		expect(plan.zombies).toHaveLength(1);
		expect(
			cu.calls.find(
				(c) =>
					c.method === "addTagToTask" &&
					(c.args as any[])[1] === "auto-archived",
			),
		).toBeDefined();
		expect(
			cu.calls.find(
				(c) =>
					c.method === "setTaskStatus" && (c.args as any[])[1] === "Closed",
			),
		).toBeDefined();
	});
});

describe("Groomer pure helpers", () => {
	it("tokenize strips date prefix, scope, and stopwords", () => {
		const tokens = tokenize("[2026-04-29] Feature(api): add user auth flow");
		expect([...tokens].sort()).toEqual(["add", "auth", "flow", "user"]);
	});

	it("jaccard returns 1 for identical token sets", () => {
		expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});

	it("jaccard handles disjoint sets as 0", () => {
		expect(jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
	});

	it("jaccard handles partial overlap", () => {
		const score = jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]));
		expect(score).toBeCloseTo(2 / 4); // intersection=2, union=4
	});
});
