import type { Job } from "bullmq";
import { SyncService } from "./sync.service";

interface InboundRow {
	id: string;
	clickup_team_id: string;
	webhook_event_id: string;
	history_item_id: string | null;
	event_type: string;
	task_id: string | null;
	payload: Record<string, unknown>;
}

interface ProjectRow {
	id: string;
	clickup_team_id: string;
	task_index: Record<string, string>;
	last_seen_status_changes: unknown[];
}

class FakePrisma {
	calls: string[] = [];
	updates: Array<{ sql: string; params: unknown[] }> = [];
	processedIds: string[] = [];

	constructor(
		private inboundRows: InboundRow[],
		private projects: ProjectRow[],
	) {}

	async $queryRawUnsafe<T>(sql: string, ..._params: unknown[]): Promise<T> {
		this.calls.push(sql);
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.includes("FROM clickup_tracker.clickup_inbound_events")) {
			return this.inboundRows.filter(
				(r) => r.processed_at === undefined || r.processed_at === null,
			) as unknown as T;
		}
		if (trimmed.includes("FROM clickup_tracker.projects")) {
			return this.projects as unknown as T;
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.updates.push({ sql, params });
		if (sql.includes("UPDATE clickup_tracker.clickup_inbound_events")) {
			this.processedIds.push(params[0] as string);
		}
		if (sql.includes("UPDATE clickup_tracker.projects")) {
			if (sql.includes("last_seen_status_changes")) {
				const project = this.projects.find((p) => p.id === params[0]);
				if (project) {
					const entry = JSON.parse(params[1] as string);
					project.last_seen_status_changes.push(entry);
				}
			}
		}
		return 1;
	}
}

class FakeQueue {
	jobs: Array<{ name: string; data: unknown }> = [];
	registerQueue(): void {
		/* noop */
	}
	async addJob(name: string, data: unknown): Promise<void> {
		this.jobs.push({ name, data });
	}
}

class FakeCredentials {
	async forOrg() {
		return { team_id: "TEAM1", token: "pk_test" };
	}
}

class FakeClickUp {
	calls: Array<{ method: string }> = [];
}

function makeJob(data: unknown): Job {
	return { id: "job1", data, name: "cup-sync" } as unknown as Job;
}

describe("SyncService — clickup_inbound handler", () => {
	it("processes one row per history item and marks each processed", async () => {
		const inbound: any[] = [
			{
				id: "INB1",
				clickup_team_id: "TEAM1",
				webhook_event_id: "WH1",
				history_item_id: "H1",
				event_type: "taskStatusUpdated",
				task_id: "TASK_A",
				payload: {},
			},
			{
				id: "INB2",
				clickup_team_id: "TEAM1",
				webhook_event_id: "WH1",
				history_item_id: "H2",
				event_type: "taskCommentPosted",
				task_id: "TASK_A",
				payload: {},
			},
		];
		const projects = [
			{
				id: "PROJ1",
				clickup_team_id: "TEAM1",
				task_index: { "commit:abcdef": "TASK_A" },
				last_seen_status_changes: [] as unknown[],
			},
		];
		const prisma = new FakePrisma(inbound, projects);
		const svc = new SyncService(
			new FakeQueue() as any,
			prisma as any,
			new FakeCredentials() as any,
			new FakeClickUp() as any,
		);
		await (svc as any).handle(
			makeJob({
				kind: "clickup_inbound",
				teamId: "TEAM1",
				webhookEventId: "WH1",
			}),
		);
		expect(prisma.processedIds.sort()).toEqual(["INB1", "INB2"]);
		expect(projects[0].last_seen_status_changes.length).toBe(2);
	});

	it("skips rows whose task_id is not in any project's task_index", async () => {
		const inbound: any[] = [
			{
				id: "INB3",
				clickup_team_id: "TEAM1",
				webhook_event_id: "WH2",
				history_item_id: "H1",
				event_type: "taskStatusUpdated",
				task_id: "TASK_UNKNOWN",
				payload: {},
			},
		];
		const projects = [
			{
				id: "PROJ1",
				clickup_team_id: "TEAM1",
				task_index: { "commit:abc": "TASK_A" },
				last_seen_status_changes: [] as unknown[],
			},
		];
		const prisma = new FakePrisma(inbound, projects);
		const svc = new SyncService(
			new FakeQueue() as any,
			prisma as any,
			new FakeCredentials() as any,
			new FakeClickUp() as any,
		);
		await (svc as any).handle(
			makeJob({
				kind: "clickup_inbound",
				teamId: "TEAM1",
				webhookEventId: "WH2",
			}),
		);
		// Row is still marked processed (we don't keep retrying unknown task ids).
		expect(prisma.processedIds).toEqual(["INB3"]);
		expect(projects[0].last_seen_status_changes.length).toBe(0);
	});

	it("git_drift handler is a no-op aside from touchLastSync", async () => {
		const prisma = new FakePrisma([], []);
		const svc = new SyncService(
			new FakeQueue() as any,
			prisma as any,
			new FakeCredentials() as any,
			new FakeClickUp() as any,
		);
		await (svc as any).handle(
			makeJob({ kind: "git_drift", projectId: "PROJ1" }),
		);
		expect(
			prisma.updates.some((u) =>
				/UPDATE clickup_tracker\.projects[\s\S]*last_synced_at\s*=\s*NOW/.test(
					u.sql,
				),
			),
		).toBe(true);
	});
});
