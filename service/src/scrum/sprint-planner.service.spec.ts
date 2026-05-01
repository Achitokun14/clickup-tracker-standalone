import {
	SprintPlannerService,
	inferGoalFromNames,
	isDoneStatus,
	mergeDefaults,
} from "./sprint-planner.service";
import { isoWeekOf } from "../util/iso-week";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	last_sprint_plan_at: Date | null;
	scrum_config: Record<string, unknown> | null;
	template_status: string | null;
	status?: string;
}

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	auditRows: any[] = [];

	constructor(private project: FakeProjectRow) {}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("SELECT id, organisation_id, clickup_team_id")) {
			return [this.project] as unknown as T;
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push({ sql, params });
		if (sql.includes("INSERT INTO clickup_tracker.scrum_audit")) {
			this.auditRows.push({
				kind: params[1],
				target: params[2],
				reason: params[5],
				dryRun: params[6],
			});
		}
		if (sql.includes("last_sprint_plan_at = NOW()")) {
			this.project.last_sprint_plan_at = new Date();
		}
		if (sql.includes("sprint_lists = sprint_lists ||")) {
			const merged = JSON.parse(params[1] as string);
			this.project.sprint_lists = { ...this.project.sprint_lists, ...merged };
		}
		return 1;
	}

	getProject(): FakeProjectRow {
		return this.project;
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
	folders: Array<{ id: string; name: string }> = [];
	createdLists: Array<{ folder: string; name: string }> = [];

	async listTasksInList(listId: string) {
		this.calls.push({ method: "listTasksInList", args: [listId] });
		return (this.tasksByList.get(listId) ?? []).map((t) => ({ ...t }));
	}
	async listFolders(_spaceId: string) {
		return this.folders.map((f) => ({ ...f }));
	}
	async createListInFolder(folderId: string, name: string) {
		this.createdLists.push({ folder: folderId, name });
		return { id: `LIST_NEW_${this.createdLists.length}`, name };
	}
	async moveTaskToList(_team: string, taskId: string, toList: string) {
		this.calls.push({ method: "moveTaskToList", args: [taskId, toList] });
	}
	async setTaskStatus(taskId: string, status: string) {
		this.calls.push({ method: "setTaskStatus", args: [taskId, status] });
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
	const svc = new SprintPlannerService(
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
	list_ids: {
		open_work: "L_OW",
		bugs: "L_BUGS",
		active_sprint: "L_ACTIVE",
		in_review: "L_REVIEW",
	},
	sprint_lists: {},
	last_sprint_plan_at: null,
	scrum_config: {},
	template_status: "configured",
};

describe("SprintPlannerService.planSprint (Plan §C.1)", () => {
	it("dryRun=true returns a plan WITHOUT moving anything", async () => {
		const { svc, cu, audit } = build({ ...baseProject });
		cu.tasksByList.set("L_ACTIVE", [
			{
				id: "T_CARRY",
				name: "[2026-04-25] Feature(api): in-progress",
				status: { type: "open" },
			},
		]);
		cu.tasksByList.set("L_BUGS", [
			{
				id: "T_BUG",
				name: "[2026-04-26] Bug(auth): null token",
				status: { status: "Backlog", type: "open" },
			},
		]);
		cu.tasksByList.set("L_OW", [
			{
				id: "T_OW1",
				name: "[2026-04-20] Feature(api): ticket A",
				status: { type: "open" },
				date_created: "1700000000000",
			},
			{
				id: "T_OW2",
				name: "[2026-04-22] Feature(api): ticket B",
				status: { type: "open" },
				date_created: "1700100000000",
			},
		]);

		const plan = await svc.planSprint(baseProject.id, true);
		expect(plan.dryRun).toBe(true);
		expect(plan.selected.length).toBeGreaterThan(0);
		expect(plan.selected[0]).toMatchObject({
			taskId: "T_CARRY",
			reason: "carryover",
		});
		// No move calls
		expect(cu.calls.some((c) => c.method === "moveTaskToList")).toBe(false);
		// Audit recorded as dry-run
		expect(audit.rows[0]).toMatchObject({ kind: "plan_sprint", dryRun: true });
	});

	it("dryRun=false moves tasks and persists last_sprint_plan_at", async () => {
		const { svc, prisma, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_ACTIVE", []);
		cu.tasksByList.set("L_BUGS", []);
		cu.tasksByList.set("L_OW", [
			{
				id: "T_A",
				name: "[2026-04-20] Feature(api): A",
				status: { type: "open" },
			},
			{
				id: "T_B",
				name: "[2026-04-21] Feature(api): B",
				status: { type: "open" },
			},
		]);
		cu.folders = [
			{ id: "F_HISTORY", name: "📜 History" },
			{ id: "F_OTHER", name: "🚧 Active Work" },
		];
		const plan = await svc.planSprint(baseProject.id, false);
		expect(plan.dryRun).toBe(false);
		expect(cu.createdLists).toHaveLength(1);
		expect(cu.createdLists[0].folder).toBe("F_HISTORY");
		expect(cu.calls.filter((c) => c.method === "moveTaskToList")).toHaveLength(
			2,
		);
		expect(prisma.getProject().last_sprint_plan_at).not.toBeNull();
	});

	it("is idempotent: a second run in the same iso_week skips", async () => {
		const project = { ...baseProject, last_sprint_plan_at: new Date() };
		const { svc, cu } = build(project);
		const plan = await svc.planSprint(baseProject.id, false);
		expect(plan.skipped).toBe("already_planned_this_week");
		expect(cu.createdLists).toHaveLength(0);
	});

	it("warming-up velocity falls back to default_velocity_points", async () => {
		const { svc, cu } = build({ ...baseProject });
		cu.tasksByList.set("L_ACTIVE", []);
		cu.tasksByList.set("L_BUGS", []);
		cu.tasksByList.set("L_OW", []);
		const plan = await svc.planSprint(baseProject.id, true);
		expect(plan.velocity.warmingUp).toBe(true);
		expect(plan.velocity.points).toBe(8);
	});

	it("computes velocity from prior closed sprint Lists when present", async () => {
		const lastWeek = isoWeekOf(
			new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
		).key;
		const project: FakeProjectRow = {
			...baseProject,
			sprint_lists: { [lastWeek]: "L_LASTWEEK" },
		};
		const { svc, cu } = build(project);
		cu.tasksByList.set("L_LASTWEEK", [
			{ id: "X1", name: "x", status: { type: "closed" } },
			{ id: "X2", name: "x", status: { type: "closed" } },
			{ id: "X3", name: "x", status: { type: "open" } },
		]);
		cu.tasksByList.set("L_ACTIVE", []);
		cu.tasksByList.set("L_BUGS", []);
		cu.tasksByList.set("L_OW", []);
		const plan = await svc.planSprint(baseProject.id, true);
		expect(plan.velocity.recent).toEqual([2]);
		expect(plan.velocity.points).toBe(2);
	});
});

describe("Sprint planner pure helpers", () => {
	it("isDoneStatus accepts closed/complete/done; rejects open/backlog", () => {
		expect(isDoneStatus("closed")).toBe(true);
		expect(isDoneStatus("complete")).toBe(true);
		expect(isDoneStatus("Done")).toBe(true);
		expect(isDoneStatus("open")).toBe(false);
		expect(isDoneStatus("Backlog")).toBe(false);
		expect(isDoneStatus(undefined)).toBe(false);
	});

	it("inferGoalFromNames returns most-common conventional-commit scope", () => {
		const names = [
			"[2026-04-29] Feature(api): A",
			"[2026-04-29] Feature(api): B",
			"[2026-04-29] Fix(auth): C",
		];
		expect(inferGoalFromNames(names)).toBe("epic:api");
	});

	it("inferGoalFromNames returns epic:mixed when no matches", () => {
		expect(inferGoalFromNames(["random task", "another"])).toBe("epic:mixed");
	});

	it("mergeDefaults merges scrum_config over hardcoded defaults", () => {
		const merged = mergeDefaults({
			velocity_window_recent: 6,
			bug_ceiling_pct: 0.5,
		});
		expect(merged.velocity_window_recent).toBe(6);
		expect(merged.bug_ceiling_pct).toBe(0.5);
		expect(merged.default_velocity_points).toBe(8); // unchanged
	});
});
