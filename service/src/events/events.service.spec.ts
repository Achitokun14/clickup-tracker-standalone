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
	status?: string;
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
	async addTagToTask(taskId: string, tag: string) {
		this.calls.push({ method: "addTagToTask", args: [taskId, tag] });
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
		status: "active",
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

	// ── Plan §C.3 — scope-rename detection ────────────────────────────
	describe("scope-rename (Plan §C.3)", () => {
		it("cross-links old + new tasks and tags both `scope-renamed` (unicode arrow)", async () => {
			const proj = makeProject({
				task_index: { "todo:legacy": "T_OLD", "todo:v2": "T_NEW" },
			});
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			await svc.ingestGit(
				proj.id,
				makeDto({
					commit_sha: "1".repeat(40),
					message: "refactor(legacy→v2): drop transitional shim",
				}),
				"key-rename-1",
			);
			const tags = clickup.calls.filter(
				(c) =>
					c.method === "addTagToTask" &&
					(c.args as any[])[1] === "scope-renamed",
			);
			expect(tags).toHaveLength(2);
			const taggedIds = tags.map((t) => (t.args as any[])[0]).sort();
			expect(taggedIds).toEqual(["T_NEW", "T_OLD"]);
			const renameComments = clickup.calls.filter(
				(c) =>
					c.method === "addComment" &&
					String((c.args as any[])[1]).includes("Scope renamed:"),
			);
			expect(renameComments).toHaveLength(2);
			// Old task gets the forward-arrow direction:
			const oldComment = renameComments.find(
				(c) => (c.args as any[])[0] === "T_OLD",
			);
			expect(String((oldComment!.args as any[])[1])).toContain("legacy → v2");
			// New task gets the back-link:
			const newComment = renameComments.find(
				(c) => (c.args as any[])[0] === "T_NEW",
			);
			expect(String((newComment!.args as any[])[1])).toContain("v2 ← legacy");
			// Original fix/feat verb path must NOT close either task on a rename.
			expect(clickup.calls.some((c) => c.method === "setTaskStatus")).toBe(
				false,
			);
		});

		it("ASCII arrow (`old->new`) is recognised the same as unicode", async () => {
			const proj = makeProject({
				task_index: { "todo:api": "T_API", "todo:apiv2": "T_APIV2" },
			});
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			await svc.ingestGit(
				proj.id,
				makeDto({
					commit_sha: "2".repeat(40),
					message: "refactor(api->apiv2): split versions",
				}),
				"key-rename-2",
			);
			const tags = clickup.calls.filter(
				(c) =>
					c.method === "addTagToTask" &&
					(c.args as any[])[1] === "scope-renamed",
			);
			expect(tags).toHaveLength(2);
		});

		it("when only old scope is tracked: comments on old + on commit task", async () => {
			const proj = makeProject({
				task_index: { "todo:legacy": "T_OLD" }, // no v2 task tracked
			});
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			await svc.ingestGit(
				proj.id,
				makeDto({
					commit_sha: "3".repeat(40),
					message: "refactor(legacy→v2): start migration",
				}),
				"key-rename-3",
			);
			const oldTag = clickup.calls.filter(
				(c) =>
					c.method === "addTagToTask" &&
					(c.args as any[])[0] === "T_OLD" &&
					(c.args as any[])[1] === "scope-renamed",
			);
			expect(oldTag).toHaveLength(1);
			const oldComment = clickup.calls.find(
				(c) =>
					c.method === "addComment" &&
					(c.args as any[])[0] === "T_OLD" &&
					String((c.args as any[])[1]).includes("Scope renamed:"),
			);
			expect(oldComment).toBeDefined();
			expect(String((oldComment!.args as any[])[1])).toContain(
				"_(no task tracked under that scope yet)_",
			);
		});

		it("plain scope (`fix(api):`) does NOT trigger rename handling", async () => {
			const proj = makeProject({
				task_index: { "todo:api": "T_API" },
			});
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			await svc.ingestGit(
				proj.id,
				makeDto({
					commit_sha: "4".repeat(40),
					message: "fix(api): handle nil",
				}),
				"key-plain",
			);
			expect(
				clickup.calls.some(
					(c) =>
						c.method === "addTagToTask" &&
						(c.args as any[])[1] === "scope-renamed",
				),
			).toBe(false);
			// fix verb path SHOULD still close the api task.
			expect(
				clickup.calls.some(
					(c) =>
						c.method === "setTaskStatus" && (c.args as any[])[0] === "T_API",
				),
			).toBe(true);
		});

		it("neither scope tracked: leaves a breadcrumb on the commit task", async () => {
			const proj = makeProject({ task_index: {} });
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			await svc.ingestGit(
				proj.id,
				makeDto({
					commit_sha: "5".repeat(40),
					message: "refactor(unknown→novel): rename out of thin air",
				}),
				"key-rename-5",
			);
			const breadcrumb = clickup.calls.find(
				(c) =>
					c.method === "addComment" &&
					String((c.args as any[])[1]).includes(
						"_(no tracked tasks under either scope yet)_",
					),
			);
			expect(breadcrumb).toBeDefined();
		});
	});

	// ── Plan §B.6 — auth-needed state machine ─────────────────────────
	describe("auth-needed (Plan §B.6)", () => {
		it("project status='auth-needed' short-circuits ingestGit (no CU writes)", async () => {
			const proj = makeProject({ status: "auth-needed" });
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const receipt = await svc.ingestGit(proj.id, makeDto(), "key-auth-1");
			expect(clickup.calls.length).toBe(0);
			expect(receipt.actions[0].kind).toBe("skipped");
			expect((receipt.actions[0] as any).reason).toBe("status:auth-needed");
		});

		it("project status='orphaned' short-circuits the same way", async () => {
			const proj = makeProject({ status: "orphaned" });
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const receipt = await svc.ingestGit(proj.id, makeDto(), "key-auth-2");
			expect(clickup.calls.length).toBe(0);
			expect((receipt.actions[0] as any).reason).toBe("status:orphaned");
		});

		it("a 401 from CU writes flips the project to auth-needed", async () => {
			const proj = makeProject();
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			// Force the createTask to throw 401
			(clickup as any).createTask = async () => {
				throw new (require("@nestjs/common").HttpException)("401", 401);
			};
			const receipt = await svc.ingestGit(proj.id, makeDto(), "key-auth-3");
			expect(
				receipt.actions.some((a) => (a as any).reason === "auth_needed"),
			).toBe(true);
			// Verify the SQL flip ran
			const flipCall = prisma.calls.find(
				(c) =>
					typeof c.sql === "string" && c.sql.includes("status = 'auth-needed'"),
			);
			expect(flipCall).toBeDefined();
		});
	});

	// ── Plan §C.3 — branch-deletion + file rename/delete ──────────────
	describe("hook lifecycle extensions (Plan §C.3)", () => {
		it("branch_deleted=true closes commit tasks for that branch", async () => {
			const proj = makeProject({
				task_index: {
					[`commit:${"a".repeat(40)}`]: "T_OLD",
					[`commit:${"b".repeat(40)}`]: "T_OLD2",
				},
			});
			const prisma = new FakePrisma(proj);
			// Stub the SHA lookup so the lifecycle finds both.
			const origQuery = prisma.$queryRawUnsafe.bind(prisma);
			(prisma as any).$queryRawUnsafe = async function (
				sql: string,
				...params: unknown[]
			) {
				if (sql.includes("SELECT commit_sha FROM clickup_tracker.git_events")) {
					return [
						{ commit_sha: "a".repeat(40) },
						{ commit_sha: "b".repeat(40) },
					];
				}
				return origQuery(sql, ...params);
			};
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "0".repeat(40),
				branch: "feature/done",
				branch_deleted: true,
			} as any);
			const receipt = await svc.ingestGit(proj.id, dto, "key-bd-1");
			const closes = clickup.calls.filter(
				(c) =>
					c.method === "setTaskStatus" && (c.args as any[])[1] === "Closed",
			);
			expect(closes.length).toBe(2);
			expect(receipt.actions.some((a) => a.kind === "close_task")).toBe(true);
		});

		it("branch_deleted=true with no matching commits returns skipped", async () => {
			const proj = makeProject();
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "0".repeat(40),
				branch: "feature/never-existed",
				branch_deleted: true,
			} as any);
			const receipt = await svc.ingestGit(proj.id, dto, "key-bd-2");
			expect(clickup.calls.length).toBe(0);
			expect(
				receipt.actions.some(
					(a) => (a as any).reason === "branch_deleted_no_tasks",
				),
			).toBe(true);
		});

		it("file rename appends a `**Renames:**` comment on the commit task", async () => {
			const proj = makeProject();
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "1".repeat(40),
				message: "refactor: rename helpers",
				files_changed: [
					{
						path: "src/util/new.ts",
						status: "renamed" as any,
						prev_path: "src/util/old.ts",
					} as any,
					{ path: "src/util/keep.ts", status: "modified" as any },
				],
			});
			await svc.ingestGit(proj.id, dto, "key-rn-1");
			const renameComment = clickup.calls.find(
				(c) =>
					c.method === "addComment" &&
					String((c.args as any[])[1]).includes("**Renames:**") &&
					String((c.args as any[])[1]).includes("src/util/old.ts"),
			);
			expect(renameComment).toBeDefined();
		});

		it("file rename without prev_path is a silent no-op (forward-compat)", async () => {
			const proj = makeProject();
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "2".repeat(40),
				message: "refactor: rename without prev_path emit",
				files_changed: [{ path: "src/util/new.ts", status: "renamed" as any }],
			});
			await svc.ingestGit(proj.id, dto, "key-rn-2");
			const renameComment = clickup.calls.find(
				(c) =>
					c.method === "addComment" &&
					String((c.args as any[])[1]).includes("**Renames:**"),
			);
			expect(renameComment).toBeUndefined();
		});

		it("file deletion closes path-anchored Open Work task", async () => {
			const proj = makeProject({
				task_index: { "path:src/util/legacy.ts": "T_LEGACY" },
			});
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "3".repeat(40),
				message: "chore: drop legacy helper",
				files_changed: [
					{ path: "src/util/legacy.ts", status: "deleted" as any },
				],
			});
			await svc.ingestGit(proj.id, dto, "key-del-1");
			const close = clickup.calls.find(
				(c) =>
					c.method === "setTaskStatus" &&
					(c.args as any[])[0] === "T_LEGACY" &&
					(c.args as any[])[1] === "Closed",
			);
			expect(close).toBeDefined();
		});

		it("file deletion with no path-anchor task is a no-op", async () => {
			const proj = makeProject(); // empty task_index
			const prisma = new FakePrisma(proj);
			const { svc, clickup } = buildSvc(prisma);
			const dto = makeDto({
				commit_sha: "4".repeat(40),
				message: "chore: drop something nobody tracked",
				files_changed: [
					{ path: "src/util/random.ts", status: "deleted" as any },
				],
			});
			await svc.ingestGit(proj.id, dto, "key-del-2");
			const close = clickup.calls.find(
				(c) =>
					c.method === "setTaskStatus" && (c.args as any[])[1] === "Closed",
			);
			expect(close).toBeUndefined();
		});
	});
});
