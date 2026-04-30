import { RepairService } from "./repair.service";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	git_default_branch: string | null;
}

class FakePrisma {
	constructor(
		private project: FakeProjectRow,
		private gitEvents: Array<{ commit_sha: string; branch: string }>,
	) {}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		if (sql.includes("FROM clickup_tracker.projects")) {
			return [this.project] as unknown as T;
		}
		if (sql.includes("FROM clickup_tracker.git_events")) {
			const shas = params[1] as string[];
			return this.gitEvents.filter((g) =>
				shas.includes(g.commit_sha),
			) as unknown as T;
		}
		return [] as unknown as T;
	}
}

class FakeCredentials {
	async forOrg() {
		return { team_id: "TEAM1", token: "pk_test" };
	}
}

class FakeClickUp {
	calls: Array<{ method: string; args: unknown[] }> = [];
	tasksByList: Map<string, Array<{ id: string; name: string }>> = new Map();

	async listTasksInList(listId: string) {
		this.calls.push({ method: "listTasksInList", args: [listId] });
		return (this.tasksByList.get(listId) ?? []).map((t) => ({ ...t }));
	}
	async archiveTask(taskId: string) {
		this.calls.push({ method: "archiveTask", args: [taskId] });
	}
	async moveTaskToList(_w: string, taskId: string, toList: string) {
		this.calls.push({ method: "moveTaskToList", args: [taskId, toList] });
	}
	async setTaskStatus(taskId: string, status: string) {
		this.calls.push({ method: "setTaskStatus", args: [taskId, status] });
	}
}

function build(
	project: FakeProjectRow,
	gitEvents: Array<{ commit_sha: string; branch: string }> = [],
) {
	const prisma = new FakePrisma(project, gitEvents);
	const creds = new FakeCredentials();
	const clickup = new FakeClickUp();
	const svc = new RepairService(prisma as any, creds as any, clickup as any);
	return { svc, prisma, clickup };
}

const baseProject: FakeProjectRow = {
	id: "11111111-1111-1111-1111-111111111111",
	organisation_id: "22222222-2222-2222-2222-222222222222",
	clickup_team_id: "TEAM1",
	clickup_space_id: "SPACE1",
	list_ids: {
		in_review: "L_IN_REVIEW",
		active_sprint: "L_ACTIVE",
		open_work: "L_OPEN",
	},
	sprint_lists: { "2026-W18": "L_SPRINT_18" },
	task_index: {
		"commit:abc1234": "T_CANONICAL",
	},
	git_default_branch: "main",
};

describe("RepairService.repairRouting (Plan §A.4 / Bug 4)", () => {
	it("dryRun=true returns plan without mutating", async () => {
		// Two tasks with the same parsed name signature in In Review
		const dup = {
			id: "T_DUPLICATE",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const can = {
			id: "T_CANONICAL",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const { svc, clickup } = build(baseProject);
		clickup.tasksByList.set("L_IN_REVIEW", [dup, can]);
		const plan = await svc.repairRouting(baseProject.id, true);
		expect(plan.dryRun).toBe(true);
		expect(plan.archive).toHaveLength(1);
		expect(plan.archive[0].taskId).toBe("T_DUPLICATE");
		// No mutating calls executed
		expect(clickup.calls.some((c) => c.method === "archiveTask")).toBe(false);
		expect(clickup.calls.some((c) => c.method === "moveTaskToList")).toBe(
			false,
		);
	});

	it("dryRun=false archives non-canonical duplicates", async () => {
		const dup = {
			id: "T_DUPLICATE",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const can = {
			id: "T_CANONICAL",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const { svc, clickup } = build(baseProject);
		clickup.tasksByList.set("L_IN_REVIEW", [dup, can]);
		const plan = await svc.repairRouting(baseProject.id, false);
		expect(plan.archive).toHaveLength(1);
		expect(clickup.calls.find((c) => c.method === "archiveTask")?.args).toEqual(
			["T_DUPLICATE"],
		);
	});

	it("moves default-branch In-Review survivors to current sprint List + Done", async () => {
		// Survivor (in task_index, on default branch) should be moved
		const can = {
			id: "T_CANONICAL",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const { svc, clickup } = build(baseProject, [
			{ commit_sha: "abc1234", branch: "main" },
		]);
		clickup.tasksByList.set("L_IN_REVIEW", [can]);
		const plan = await svc.repairRouting(baseProject.id, false);
		expect(plan.move).toHaveLength(1);
		expect(plan.move[0]).toMatchObject({
			taskId: "T_CANONICAL",
			fromList: "L_IN_REVIEW",
			toList: "L_SPRINT_18",
		});
		// Mutating calls executed
		expect(
			clickup.calls.find(
				(c) =>
					c.method === "moveTaskToList" &&
					(c.args as any[])[0] === "T_CANONICAL",
			),
		).toBeDefined();
		expect(
			clickup.calls.find(
				(c) =>
					c.method === "setTaskStatus" &&
					(c.args as any[])[0] === "T_CANONICAL",
			),
		).toBeDefined();
	});

	it("does NOT move tasks whose underlying branch is non-default", async () => {
		const can = {
			id: "T_CANONICAL",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const { svc, clickup } = build(baseProject, [
			{ commit_sha: "abc1234", branch: "feature/x" },
		]);
		clickup.tasksByList.set("L_IN_REVIEW", [can]);
		const plan = await svc.repairRouting(baseProject.id, false);
		expect(plan.move).toHaveLength(0);
	});

	it("is idempotent: a second run finds nothing to archive/move", async () => {
		const can = {
			id: "T_CANONICAL",
			name: "[2026-04-29] Feature(api): bootstrap script",
		};
		const { svc, clickup } = build(baseProject, []);
		clickup.tasksByList.set("L_IN_REVIEW", [can]);
		const first = await svc.repairRouting(baseProject.id, false);
		expect(first.archive).toHaveLength(0);
		const second = await svc.repairRouting(baseProject.id, false);
		expect(second.archive).toHaveLength(0);
		expect(second.move).toHaveLength(0);
	});

	it("ignores tasks whose name does not match the auto-imported pattern", async () => {
		const human = { id: "T_HUMAN", name: "Manually-named task" };
		const { svc } = build(baseProject);
		const plan = await svc.repairRouting(baseProject.id, true);
		// No groups recorded, no archive/move
		expect(plan.archive).toHaveLength(0);
		expect(plan.move).toHaveLength(0);
	});
});
