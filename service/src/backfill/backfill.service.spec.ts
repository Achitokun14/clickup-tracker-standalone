import { BackfillService } from "./backfill.service";

interface FakeProject {
	id: string;
	organisation_id: string;
	local_path: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string | null;
	clickup_folder_id: string | null;
	clickup_doc_id: string | null;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	task_index: Record<string, string>;
	backfill_state: { status: string; [k: string]: unknown };
	scope_config: { mode: string };
	git_remote_url: string | null;
	git_default_branch: string | null;
}

class FakePrisma {
	private project: FakeProject;
	settingsRow: {
		members_cache: Record<string, number>;
		members_cached_at: Date | null;
	} = {
		members_cache: { "achrafalaoui14@gmail.com": 42 },
		members_cached_at: new Date(),
	};
	calls: string[] = [];

	constructor(initial: FakeProject) {
		this.project = initial;
	}

	async $queryRawUnsafe<T>(sql: string, ..._params: unknown[]): Promise<T> {
		this.calls.push(sql);
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("SELECT id, organisation_id, local_path")) {
			return [this.project] as unknown as T;
		}
		if (trimmed.startsWith("SELECT clickup_team_id, members_cache")) {
			return [
				{
					clickup_team_id: this.project.clickup_team_id,
					members_cache: this.settingsRow.members_cache,
					members_cached_at: this.settingsRow.members_cached_at,
				},
			] as unknown as T;
		}
		if (trimmed.startsWith("SELECT backfill_state")) {
			return [{ backfill_state: this.project.backfill_state }] as unknown as T;
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push(sql);
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (
			trimmed.startsWith("UPDATE clickup_tracker.projects SET clickup_space_id")
		) {
			this.project.clickup_space_id = params[0] as string;
		} else if (
			// appendBackfillError: SET backfill_state = jsonb_set(... '{errors}' ...)
			sql.includes("jsonb_set") &&
			sql.includes("'{errors}'")
		) {
			const errors = (this.project.backfill_state.errors as unknown[]) ?? [];
			errors.push({
				op: params[1],
				message: params[2],
				at: new Date().toISOString(),
			});
			this.project.backfill_state = {
				...this.project.backfill_state,
				errors,
			};
		} else if (trimmed.startsWith("UPDATE clickup_tracker.projects SET")) {
			if (sql.includes("backfill_state")) {
				const patch = JSON.parse(params[0] as string);
				this.project.backfill_state = {
					...this.project.backfill_state,
					...patch,
				};
			}
			if (sql.includes("clickup_folder_id = COALESCE")) {
				this.project.clickup_folder_id = params[0] as string;
				this.project.list_ids = JSON.parse(params[1] as string);
				this.project.sprint_lists = JSON.parse(params[2] as string);
			}
			if (sql.includes("task_index = $1::jsonb")) {
				this.project.task_index = JSON.parse(params[0] as string);
			}
			if (sql.includes("clickup_doc_id = $1")) {
				this.project.clickup_doc_id = params[0] as string;
			}
		}
		return 1;
	}

	getProject(): FakeProject {
		return this.project;
	}
}

class FakeQueue {
	registered: Array<{ name: string; handler: any }> = [];
	registerQueue(name: string, handler: any): void {
		this.registered.push({ name, handler });
	}
	async addJob(): Promise<void> {
		/* noop */
	}
}

class FakeCredentials {
	async forOrg() {
		return { team_id: "TEAM1", token: "pk_test_xxxxxxxxxxxxxxxxxx" };
	}
}

class FakeClickUp {
	calls: Array<{ method: string; args: unknown[] }> = [];
	createdTaskCounter = 0;
	failCreateDoc = false;
	failPagesNamed: Set<string> = new Set();
	seededSpaces: Array<{ id: string; name: string }> = [];

	async listSpaces() {
		this.calls.push({ method: "listSpaces", args: [] });
		return this.seededSpaces.map((s) => ({ ...s }));
	}
	async createSpace(_t: string, name: string) {
		this.calls.push({ method: "createSpace", args: [name] });
		return { id: "SPACE1", name };
	}
	async setSpaceStatuses() {
		this.calls.push({ method: "setSpaceStatuses", args: [] });
	}
	async listSpaceTags() {
		return [];
	}
	async createSpaceTag(_s: string, name: string) {
		this.calls.push({ method: "createSpaceTag", args: [name] });
	}
	async listFolders() {
		return [];
	}
	async createFolder(_s: string, name: string) {
		this.calls.push({ method: "createFolder", args: [name] });
		return { id: `FOLDER:${name}`, name };
	}
	async listListsInFolder() {
		return [];
	}
	async createListInFolder(_f: string, name: string) {
		this.calls.push({ method: "createListInFolder", args: [name] });
		return { id: `LIST:${name}`, name };
	}
	async setListStatuses() {
		this.calls.push({ method: "setListStatuses", args: [] });
	}
	async createDoc() {
		this.calls.push({ method: "createDoc", args: [] });
		if (this.failCreateDoc) throw new Error("simulated createDoc 500");
		return { id: "DOC1" };
	}
	async createDocPage(_t: string, _d: string, body: { name: string }) {
		this.calls.push({ method: "createDocPage", args: [body.name] });
		if (this.failPagesNamed.has(body.name))
			throw new Error(`simulated createDocPage(${body.name}) 500`);
		return { id: "PAGE" };
	}
	async createListView() {
		this.calls.push({ method: "createListView", args: [] });
		return { view: { id: "VIEW" } };
	}
	async listMembers() {
		return [{ id: 42, email: "achrafalaoui14@gmail.com" }];
	}
	async createTask(listId: string, body: { name: string }) {
		this.createdTaskCounter++;
		this.calls.push({ method: "createTask", args: [listId, body.name] });
		return { id: `TASK${this.createdTaskCounter}`, name: body.name };
	}
	async addComment() {
		/* noop */
	}
	async assignTask() {
		this.calls.push({ method: "assignTask", args: [] });
	}
}

class FakeGitHistory {
	async extract(_p: string) {
		return {
			commits: [
				{
					sha: "a".repeat(40),
					parents: [],
					author: {
						name: "A",
						email: "achrafalaoui14@gmail.com",
						date: "2026-04-14T12:00:00Z",
					},
					committer: {
						name: "A",
						email: "achrafalaoui14@gmail.com",
						date: "2026-04-14T12:00:00Z",
					},
					refs: ["main", "origin/main"],
					branch: "main",
					subject: "feat(api): bootstrap",
					body: "",
					type: "Feature" as const,
					scope: "api",
					filesChanged: [
						{
							path: "src/api.ts",
							additions: 30,
							deletions: 5,
							status: "M" as const,
						},
					],
					isMergeCommit: false,
					sprintKey: "2026-W16",
					sprintOrdinal: 1,
					sprintRange: { startDate: "2026-04-13", endDate: "2026-04-19" },
				},
			],
			sprints: [
				{
					key: "2026-W16",
					ordinal: 1,
					startDate: "2026-04-13",
					endDate: "2026-04-19",
					commitCount: 1,
				},
			],
			remote: { url: null, host: null, ownerRepo: null },
			defaultBranch: "main",
			truncated: false,
		};
	}
}

class FakeRepoExtract {
	async extract(_p: string) {
		return {
			readme: { title: "Sample", excerpt: "# Sample" },
			changelogEntries: [],
			stateEntries: [],
			todos: [],
			todosOverflow: 0,
			lastCommitISO: "2026-04-14T12:00:00Z",
			pkgMeta: null,
		};
	}
}

function makeFakeProject(): FakeProject {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		organisation_id: "00000000-0000-0000-0000-000000000abc",
		local_path: "/repos/sample",
		display_name: "Sample Repo",
		clickup_team_id: "TEAM1",
		clickup_space_id: null,
		clickup_folder_id: null,
		clickup_doc_id: null,
		list_ids: {},
		sprint_lists: {},
		task_index: {},
		backfill_state: { status: "queued" },
		scope_config: { mode: "root" },
		git_remote_url: null,
		git_default_branch: null,
	};
}

function buildService(prisma: FakePrisma): {
	svc: BackfillService;
	clickup: FakeClickUp;
} {
	const queue = new FakeQueue();
	const creds = new FakeCredentials();
	const clickup = new FakeClickUp();
	const git = new FakeGitHistory();
	const rext = new FakeRepoExtract();
	const svc = new BackfillService(
		queue as any,
		prisma as any,
		creds as any,
		clickup as any,
		git as any,
		rext as any,
	);
	return { svc, clickup };
}

describe("BackfillService", () => {
	it("walks the SpacePlan end-to-end on a fresh project", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		const state = await svc.runFor("00000000-0000-0000-0000-000000000001");

		expect(state.status).toBe("done");
		expect(state.total).toBeGreaterThan(0);
		expect(prisma.getProject().clickup_space_id).toBe("SPACE1");
		expect(prisma.getProject().task_index["commit:" + "a".repeat(40)]).toMatch(
			/^TASK/,
		);

		const created = clickup.calls.filter((c) => c.method === "createTask");
		expect(created.length).toBeGreaterThan(0);

		// folders + lists were emitted (4 folders + at least 6 lists incl. sprint).
		const folders = clickup.calls.filter((c) => c.method === "createFolder");
		const lists = clickup.calls.filter(
			(c) => c.method === "createListInFolder",
		);
		expect(folders.length).toBe(4);
		expect(lists.length).toBeGreaterThanOrEqual(7);
	});

	it("is idempotent: a second run does not re-create existing tasks", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		const firstCreates = clickup.calls.filter(
			(c) => c.method === "createTask",
		).length;

		// The task_index now has the commit task. Run again; createTask must be
		// called fewer times (only for tasks not yet in the index — i.e. zero
		// because the planner is deterministic on the same fixture).
		const before = clickup.calls.length;
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		const secondCreates = clickup.calls
			.slice(before)
			.filter((c) => c.method === "createTask").length;

		expect(firstCreates).toBeGreaterThan(0);
		expect(secondCreates).toBe(0);
	});

	it("persists folder_url + space_url on completion", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc } = buildService(prisma);
		const state = await svc.runFor("00000000-0000-0000-0000-000000000001");
		expect(state.space_url).toMatch(/app\.clickup\.com\/TEAM1\/v\/s\/SPACE1/);
		// active_sprint List was created → folder_url should resolve.
		expect(state.folder_url).toMatch(/app\.clickup\.com\/TEAM1\/v\/li\//);
	});

	it("getState returns the persisted backfill_state", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc } = buildService(prisma);
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		const state = await svc.getState("00000000-0000-0000-0000-000000000001");
		expect(state?.status).toBe("done");
	});

	it("ensureDoc persists clickup_doc_id even when later page-creates fail (Bug 2)", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		// Fail every page; createDoc itself succeeds.
		clickup.failPagesNamed = new Set([
			"Overview",
			"Setup",
			"Conventions",
			"Changelog",
			"Agent Prompt Log",
		]);
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		// docId persisted despite all 5 page failures
		expect(prisma.getProject().clickup_doc_id).toBe("DOC1");
		// Each page failure recorded
		const errors = (prisma.getProject().backfill_state as any).errors ?? [];
		expect(errors.length).toBeGreaterThanOrEqual(5);
		expect(errors.some((e: any) => e.op?.startsWith("createDocPage:"))).toBe(
			true,
		);
	});

	it("ensureDoc records createDoc failure in backfill_state.errors and leaves docId null", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		clickup.failCreateDoc = true;
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		expect(prisma.getProject().clickup_doc_id).toBeNull();
		const errors = (prisma.getProject().backfill_state as any).errors ?? [];
		expect(errors.some((e: any) => e.op === "createDoc")).toBe(true);
	});

	it("ensureSpace adopts an existing same-name Space (Plan §A.5 wipe-aware re-register)", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		clickup.seededSpaces = [{ id: "SPACE_PREEXISTING", name: "Sample Repo" }];
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		// Adopted, not created
		expect(clickup.calls.some((c) => c.method === "createSpace")).toBe(false);
		expect(prisma.getProject().clickup_space_id).toBe("SPACE_PREEXISTING");
	});

	it("ensureSpace creates a new Space when no name match exists (regression)", async () => {
		const prisma = new FakePrisma(makeFakeProject());
		const { svc, clickup } = buildService(prisma);
		clickup.seededSpaces = [{ id: "SPACE_OTHER", name: "Unrelated Repo" }];
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		expect(clickup.calls.some((c) => c.method === "createSpace")).toBe(true);
		expect(prisma.getProject().clickup_space_id).toBe("SPACE1");
	});

	it("ensureDoc is a no-op on second run when clickup_doc_id already set", async () => {
		const project = makeFakeProject();
		project.clickup_doc_id = "DOC_PRE_EXISTING";
		const prisma = new FakePrisma(project);
		const { svc, clickup } = buildService(prisma);
		await svc.runFor("00000000-0000-0000-0000-000000000001");
		// createDoc must not have been called
		expect(clickup.calls.some((c) => c.method === "createDoc")).toBe(false);
		expect(prisma.getProject().clickup_doc_id).toBe("DOC_PRE_EXISTING");
	});
});
