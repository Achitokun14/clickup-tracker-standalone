import { EventsService } from "./events.service";
import type { GitEventDto } from "./dto/git-event.dto";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	clickup_folder_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	scope_config: { mode?: string; paths?: string[] };
	git_default_branch: string | null;
	git_remote_url: string | null;
	git_remote_host: string | null;
	git_remote_owner_repo: string | null;
}

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	insertedEvents = 0;
	processed = new Set<string>();
	constructor(private project: FakeProjectRow) {}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("SELECT id, organisation_id, display_name")) {
			return [this.project] as unknown as T;
		}
		if (trimmed.startsWith("INSERT INTO clickup_tracker.processed_events")) {
			const key = String(params[0]);
			if (this.processed.has(key)) return [] as unknown as T;
			this.processed.add(key);
			return [{ inserted: true }] as unknown as T;
		}
		if (trimmed.startsWith("INSERT INTO clickup_tracker.git_events")) {
			if (this.failGitInsertWithTeamUniqueViolation) {
				throw new Error(
					'duplicate key value violates unique constraint "git_events_team_sha_uniq"',
				);
			}
			this.insertedEvents += 1;
			return [{ id: `EVT${this.insertedEvents}` }] as unknown as T;
		}
		if (
			trimmed.startsWith(
				"SELECT id FROM clickup_tracker.git_events WHERE clickup_team_id",
			)
		) {
			return [{ id: "EVT_PEER" }] as unknown as T;
		}
		return [] as unknown as T;
	}

	failGitInsertWithTeamUniqueViolation = false;

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push({ sql, params });
		// Simulate task_index merge so subsequent reads see the new key.
		if (sql.includes("task_index = task_index || $2::jsonb")) {
			const additions = JSON.parse(params[1] as string);
			this.project.task_index = { ...this.project.task_index, ...additions };
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
	idCounter = 0;
	async createTask(listId: string, body: { name: string }) {
		this.idCounter += 1;
		this.calls.push({
			method: "createTask",
			args: [listId, body.name],
		});
		return { id: `T${this.idCounter}`, name: body.name };
	}
	async addComment(taskId: string, text: string) {
		this.calls.push({ method: "addComment", args: [taskId, text] });
	}
	async setTaskStatus(taskId: string, status: string) {
		this.calls.push({ method: "setTaskStatus", args: [taskId, status] });
	}
}

class FakeSync {
	enqueued: unknown[] = [];
	async enqueue(payload: unknown) {
		this.enqueued.push(payload);
	}
}

function makeProject(overrides: Partial<FakeProjectRow> = {}): FakeProjectRow {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		organisation_id: "00000000-0000-0000-0000-000000000abc",
		display_name: "Sample",
		clickup_team_id: "TEAM1",
		clickup_space_id: "SPACE1",
		clickup_folder_id: "FOLDER1",
		list_ids: {
			open_work: "LIST_OW",
			active_sprint: "LIST_ACTIVE",
			in_review: "LIST_REVIEW",
			bugs: "LIST_BUGS",
		},
		sprint_lists: { "2026-W17": "LIST_SPRINT_W17" },
		task_index: {},
		scope_config: { mode: "root", paths: [] },
		git_default_branch: "main",
		git_remote_url: "git@github.com:Achitokun14/sample.git",
		git_remote_host: "github.com",
		git_remote_owner_repo: "Achitokun14/sample",
		...overrides,
	};
}

function makeDto(overrides: Partial<GitEventDto> = {}): GitEventDto {
	return {
		commit_sha: "a".repeat(40),
		branch: "main",
		author: "Achraf",
		committer_email: "achrafalaoui14@gmail.com",
		committed_at: "2026-04-22T12:00:00Z", // ISO week 17
		message: "feat(api): new endpoint",
		files_changed: [
			{ path: "src/api.ts", status: "modified", additions: 30, deletions: 5 },
		],
		todo_diffs: [],
		...overrides,
	};
}

function buildSvc(prisma: FakePrisma): {
	svc: EventsService;
	clickup: FakeClickUp;
	sync: FakeSync;
} {
	const creds = new FakeCredentials();
	const clickup = new FakeClickUp();
	const sync = new FakeSync();
	const svc = new EventsService(
		prisma as any,
		creds as any,
		clickup as any,
		sync as any,
	);
	return { svc, clickup, sync };
}

describe("EventsService — per-repo Space lifecycle", () => {
	it("creates a commit task in the matching sprint List on the default branch", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		const receipt = await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto(),
			"key1",
			"claude-code",
		);
		expect(receipt.replayed).toBe(false);
		const create = clickup.calls.find((c) => c.method === "createTask");
		expect(create).toBeDefined();
		expect(create?.args[0]).toBe("LIST_SPRINT_W17");
		expect(String(create?.args[1])).toContain("Feature(api)");
		expect(prisma.getProject().task_index["commit:" + "a".repeat(40)]).toBe(
			"T1",
		);
	});

	it("routes non-default-branch commits to the In Review List", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({ branch: "feat/wip", commit_sha: "b".repeat(40) }),
			"key2",
		);
		const create = clickup.calls.find((c) => c.method === "createTask");
		expect(create?.args[0]).toBe("LIST_REVIEW");
	});

	it("falls back to active_sprint when sprint list missing", async () => {
		const project = makeProject({ sprint_lists: {} });
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto(),
			"key3",
		);
		const create = clickup.calls.find((c) => c.method === "createTask");
		expect(create?.args[0]).toBe("LIST_ACTIVE");
	});

	it("never re-creates a commit task already in task_index", async () => {
		const project = makeProject({
			task_index: { ["commit:" + "a".repeat(40)]: "T_existing" },
		});
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto(),
			"key4",
		);
		const creates = clickup.calls.filter((c) => c.method === "createTask");
		expect(creates.length).toBe(0);
	});

	it("real status transition on TODO removal (not just a comment)", async () => {
		const project = makeProject({
			task_index: { "todo:src/x.ts:10": "T_todo" },
		});
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "c".repeat(40),
				todo_diffs: [
					{
						file: "src/x.ts",
						line: 10,
						marker: "TODO",
						op: "remove",
						text: "x",
					},
				],
			}),
			"key5",
		);
		const transition = clickup.calls.find(
			(c) =>
				c.method === "setTaskStatus" &&
				c.args[0] === "T_todo" &&
				c.args[1] === "Done",
		);
		expect(transition).toBeDefined();
	});

	it("scope_config mode='subdir' rejects commits with no matching files", async () => {
		const project = makeProject({
			scope_config: { mode: "subdir", paths: ["service/"] },
		});
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildSvc(prisma);
		const receipt = await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "d".repeat(40),
				files_changed: [{ path: "mcp/src/server.ts" }],
			}),
			"key6",
		);
		expect(clickup.calls.length).toBe(0);
		expect(receipt.actions.some((a) => a.kind === "skipped")).toBe(true);
	});

	it("scope_config subdir accepts commits touching tracked paths", async () => {
		const project = makeProject({
			scope_config: { mode: "subdir", paths: ["service/"] },
		});
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "e".repeat(40),
				files_changed: [{ path: "service/src/foo.ts" }],
			}),
			"key7",
		);
		expect(clickup.calls.find((c) => c.method === "createTask")).toBeDefined();
	});

	it("idempotent on dedupe-key (replay)", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto(),
			"key-replay",
		);
		const callsAfterFirst = clickup.calls.length;
		const second = await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto(),
			"key-replay",
		);
		expect(second.replayed).toBe(true);
		expect(clickup.calls.length).toBe(callsAfterFirst);
	});

	it("resolveBranch synthesises default when dto.branch is empty (Bug 1, layer 2)", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc } = buildSvc(prisma);
		// resolveBranch is private; call via cast for the test.
		const out = (svc as any).resolveBranch(
			{ branch: "" },
			{ id: "p1", git_default_branch: "trunk" },
		);
		expect(out).toBe("trunk");
	});

	it("resolveBranch passes through populated branch unchanged", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc } = buildSvc(prisma);
		const out = (svc as any).resolveBranch(
			{ branch: "feature/x" },
			{ id: "p1", git_default_branch: "main" },
		);
		expect(out).toBe("feature/x");
	});

	it("resolveBranch falls back to 'main' when project has no git_default_branch", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc } = buildSvc(prisma);
		const out = (svc as any).resolveBranch(
			{ branch: null },
			{ id: "p1", git_default_branch: null },
		);
		expect(out).toBe("main");
	});

	it("ingestGit dedupes when peer daemon already recorded this SHA at the team level (Plan §B.4)", async () => {
		const prisma = new FakePrisma(makeProject());
		prisma.failGitInsertWithTeamUniqueViolation = true;
		const { svc, clickup } = buildSvc(prisma);
		const receipt = await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "b".repeat(40),
				message: "feat(api): same SHA committed by another dev",
			}),
			"peer-daemon-key",
		);
		expect(receipt.eventId).toBe("EVT_PEER");
		expect(receipt.replayed).toBe(true);
		expect(receipt.actions[0]).toMatchObject({
			kind: "skipped",
			reason: "peer_daemon_owns",
		});
		// CU emission must be skipped — the first daemon owns the task.
		expect(clickup.calls.some((c) => c.method === "createTask")).toBe(false);
	});

	it("appends a single Artifact watch comment when the commit touches non-code files (Plan §C.5)", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "c".repeat(40),
				message: "chore(deps): bump axios + update CI image",
				files_changed: [
					{ path: "package.json", status: "modified" },
					{ path: ".github/workflows/ci.yml", status: "modified" },
					{ path: "README.md", status: "modified" },
					{ path: "src/api.ts", status: "modified" },
					{ path: "yarn.lock", status: "modified" },
				],
			}),
			"key-artifacts",
		);
		const comment = clickup.calls.find((c) => c.method === "addComment");
		expect(comment).toBeDefined();
		const text = String((comment!.args as any[])[1]);
		expect(text).toContain("Artifact watch");
		expect(text).toContain("dependency × 1");
		expect(text).toContain("infra × 1");
		expect(text).toContain("doc × 1");
		// generated (yarn.lock) + code (src/api.ts) MUST NOT appear.
		expect(text).not.toContain("generated");
		expect(text).not.toContain("code ×");
	});

	it("does NOT post an Artifact watch comment when only code files change", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "d".repeat(40),
				message: "feat(api): rename handler",
				files_changed: [
					{ path: "src/api.ts", status: "modified" },
					{ path: "src/util.ts", status: "modified" },
				],
			}),
			"key-code-only",
		);
		const comments = clickup.calls.filter(
			(c) =>
				c.method === "addComment" &&
				String((c.args as any[])[1]).includes("Artifact watch"),
		);
		expect(comments).toHaveLength(0);
	});

	it("respects the clickup-skip marker", async () => {
		const prisma = new FakePrisma(makeProject());
		const { svc, clickup } = buildSvc(prisma);
		const receipt = await svc.ingestGit(
			"00000000-0000-0000-0000-000000000001",
			makeDto({
				commit_sha: "f".repeat(40),
				message: "chore: housekeeping\n\nclickup-skip: true",
			}),
			"key-skip",
		);
		expect(receipt.actions.some((a) => a.kind === "skipped")).toBe(true);
		expect(clickup.calls.length).toBe(0);
	});
});
