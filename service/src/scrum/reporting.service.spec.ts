import {
	extractSubject,
	isWeekendUtc,
	renderRetroMd,
	renderStandupMd,
	ReportingService,
} from "./reporting.service";

interface FakeProjectRow {
	id: string;
	organisation_id: string;
	clickup_team_id: string;
	clickup_doc_id: string | null;
	display_name: string;
	list_ids: Record<string, string>;
	sprint_lists: Record<string, string>;
	scrum_config: Record<string, unknown> | null;
	last_standup_at: Date | null;
	last_retro_at: Date | null;
	velocity_window: Array<{
		iso_week: string;
		committed_tasks: number;
		at: string;
	}> | null;
	status?: string;
}

interface FakeGitEvent {
	commit_sha: string;
	author: string | null;
	committer_email: string | null;
	message: string;
}

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	events24h: FakeGitEvent[] = [];
	commitCount = 0;

	constructor(private project: FakeProjectRow) {}

	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		const trimmed = sql.replace(/\s+/g, " ").trim();
		if (trimmed.startsWith("SELECT id, organisation_id, clickup_team_id")) {
			return [this.project] as unknown as T;
		}
		if (
			sql.includes("FROM clickup_tracker.git_events") &&
			sql.includes("LIMIT 100")
		) {
			return this.events24h as unknown as T;
		}
		if (sql.includes("COUNT(*)::bigint AS n")) {
			return [{ n: BigInt(this.commitCount) }] as unknown as T;
		}
		return [] as unknown as T;
	}

	async $executeRawUnsafe(sql: string, ..._params: unknown[]): Promise<number> {
		this.calls.push({ sql, params: _params });
		if (sql.includes("last_standup_at = NOW()")) {
			this.project.last_standup_at = new Date();
		}
		if (sql.includes("last_retro_at = NOW()")) {
			this.project.last_retro_at = new Date();
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
	pages: Array<{ id: string; name: string; parent_page_id?: string | null }> =
		[];
	createdPages: any[] = [];
	createPageError: Error | null = null;

	async listTasksInList(listId: string) {
		this.calls.push({ method: "listTasksInList", args: [listId] });
		return (this.tasksByList.get(listId) ?? []).map((t) => ({ ...t }));
	}
	async listDocPages(_team: string, _doc: string, _token: string) {
		this.calls.push({ method: "listDocPages", args: [_team, _doc] });
		return this.pages;
	}
	async createDocPage(
		_team: string,
		_doc: string,
		body: { name: string; content: string; parent_page_id?: string },
		_token: string,
	) {
		this.calls.push({ method: "createDocPage", args: [_team, _doc, body] });
		if (this.createPageError) throw this.createPageError;
		const id = `PAGE_${this.createdPages.length + 1}`;
		this.createdPages.push({ id, ...body });
		return { id };
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
	const reviewEvents = {
		slaForProject: jest.fn().mockResolvedValue([]),
	};
	const svc = new ReportingService(
		prisma as any,
		creds as any,
		cu as any,
		audit as any,
		reviewEvents as any,
	);
	return { svc, prisma, cu, audit, reviewEvents };
}

const baseProject: FakeProjectRow = {
	id: "11111111-1111-1111-1111-111111111111",
	organisation_id: "22222222-2222-2222-2222-222222222222",
	clickup_team_id: "TEAM1",
	clickup_doc_id: "DOC1",
	display_name: "test-project",
	list_ids: { open_work: "L_OW", bugs: "L_BUGS", in_review: "L_IR" },
	sprint_lists: {},
	scrum_config: { skip_weekends: true },
	last_standup_at: null,
	last_retro_at: null,
	velocity_window: [],
};

describe("ReportingService.generateStandup (Plan §C.4)", () => {
	it("dryRun=true renders markdown but does NOT post to CU", async () => {
		const { svc, cu, audit } = build({ ...baseProject });
		// Force a weekday by stubbing isWeekendUtc through a known weekday value:
		// the service consults `new Date()` directly. We test the post-skip
		// path by setting cu.pages so ensureSubpage would find it.
		const dow = new Date().getUTCDay();
		if (dow === 0 || dow === 6) {
			// Today is a weekend in real time — skip this assertion shape.
			const r = await svc.generateStandup(baseProject.id, true);
			expect(r.skipped).toBe("weekend");
			return;
		}
		const report = await svc.generateStandup(baseProject.id, true);
		expect(report.dryRun).toBe(true);
		expect(report.skipped).toBeUndefined();
		expect(report.markdown).toContain("# Standup");
		expect(cu.calls.some((c) => c.method === "createDocPage")).toBe(false);
		expect(audit.rows.some((r) => r.kind === "standup" && r.dryRun)).toBe(true);
	});

	it("returns skipped=already_done_today when last_standup_at is today", async () => {
		const { svc } = build({ ...baseProject, last_standup_at: new Date() });
		const report = await svc.generateStandup(baseProject.id, false);
		expect(report.skipped).toBe("already_done_today");
	});

	it("returns skipped=no_doc when project has no clickup_doc_id", async () => {
		const dow = new Date().getUTCDay();
		if (dow === 0 || dow === 6) return; // skip on weekends
		const { svc } = build({ ...baseProject, clickup_doc_id: null });
		const report = await svc.generateStandup(baseProject.id, false);
		expect(report.skipped).toBe("no_doc");
	});

	it("groups commits by author email into markdown sections", async () => {
		const dow = new Date().getUTCDay();
		if (dow === 0 || dow === 6) return;
		const { svc, prisma } = build({ ...baseProject });
		prisma.events24h = [
			{
				commit_sha: "deadbeef",
				author: "ali@example.com",
				committer_email: null,
				message: "feat: add login",
			},
			{
				commit_sha: "cafebabe",
				author: "ali@example.com",
				committer_email: null,
				message: "fix: nil deref",
			},
			{
				commit_sha: "1234abcd",
				author: "bob@example.com",
				committer_email: null,
				message: "chore: bump dep",
			},
		];
		const report = await svc.generateStandup(baseProject.id, true);
		expect(report.authors).toBe(2);
		expect(report.commits).toBe(3);
		expect(report.markdown).toContain("ali@example.com");
		expect(report.markdown).toContain("bob@example.com");
	});

	it("dryRun=false posts page + persists last_standup_at + records audit", async () => {
		const dow = new Date().getUTCDay();
		if (dow === 0 || dow === 6) return;
		const proj: FakeProjectRow = { ...baseProject };
		const { svc, cu, audit, prisma } = build(proj);
		const report = await svc.generateStandup(proj.id, false);
		expect(report.skipped).toBeUndefined();
		expect(report.pageId).toMatch(/^PAGE_/);
		expect(cu.createdPages.some((p) => /^Standup —/.test(p.name))).toBe(true);
		expect(
			prisma.calls.some((c) => c.sql.includes("last_standup_at = NOW()")),
		).toBe(true);
		expect(audit.rows.some((r) => r.kind === "standup" && !r.dryRun)).toBe(
			true,
		);
	});

	it("recovers gracefully when page post fails (returns skipped=page_post_failed)", async () => {
		const dow = new Date().getUTCDay();
		if (dow === 0 || dow === 6) return;
		const { svc, cu } = build({ ...baseProject });
		cu.createPageError = new Error("CU 500");
		const report = await svc.generateStandup(baseProject.id, false);
		expect(report.skipped).toBe("page_post_failed");
	});
});

describe("ReportingService.generateRetro (Plan §C.4)", () => {
	it("dryRun=true renders markdown without posting", async () => {
		const { svc, cu, audit } = build({ ...baseProject });
		const report = await svc.generateRetro(baseProject.id, true);
		expect(report.dryRun).toBe(true);
		expect(report.markdown).toContain("# Retro");
		expect(cu.calls.some((c) => c.method === "createDocPage")).toBe(false);
		expect(audit.rows.some((r) => r.kind === "retro" && r.dryRun)).toBe(true);
	});

	it("returns skipped=no_doc when clickup_doc_id missing", async () => {
		const { svc } = build({ ...baseProject, clickup_doc_id: null });
		const report = await svc.generateRetro(baseProject.id, false);
		expect(report.skipped).toBe("no_doc");
	});

	it("counts delivered vs carryover from current sprint List", async () => {
		const proj = { ...baseProject };
		const { svc, cu, prisma } = build(proj);
		// Inject sprint list mapping for this iso_week. Compute it the way
		// the service does (isoWeekOf(now).key).
		const { isoWeekOf } = await import("../util/iso-week");
		const wk = isoWeekOf(new Date()).key;
		proj.sprint_lists = { [wk]: "L_SPRINT" };
		proj.velocity_window = [
			{ iso_week: wk, committed_tasks: 5, at: new Date().toISOString() },
		];
		cu.tasksByList.set("L_SPRINT", [
			{ id: "T1", name: "x", status: { type: "closed" } },
			{ id: "T2", name: "y", status: { type: "closed" } },
			{ id: "T3", name: "z", status: { type: "open" } },
		]);
		const report = await svc.generateRetro(proj.id, true);
		expect(report.committedTasks).toBe(5);
		expect(report.deliveredTasks).toBe(2);
		expect(report.carryoverCount).toBe(1);
		expect(prisma.calls.length).toBeGreaterThan(0);
	});

	it("idempotent: skips when last_retro_at is in the same iso_week", async () => {
		const proj = { ...baseProject, last_retro_at: new Date() };
		const { svc } = build(proj);
		const report = await svc.generateRetro(proj.id, false);
		expect(report.skipped).toBe("already_done_this_sprint");
	});

	it("dryRun=false posts retro page + persists last_retro_at", async () => {
		const proj = { ...baseProject };
		const { svc, cu, prisma } = build(proj);
		const report = await svc.generateRetro(proj.id, false);
		expect(report.skipped).toBeUndefined();
		expect(report.pageId).toMatch(/^PAGE_/);
		expect(cu.createdPages.some((p) => /^Retro —/.test(p.name))).toBe(true);
		expect(
			prisma.calls.some((c) => c.sql.includes("last_retro_at = NOW()")),
		).toBe(true);
	});
});

describe("pure helpers", () => {
	it("isWeekendUtc detects Sat + Sun from UTC day-of-week", () => {
		const sat = new Date("2026-05-02T12:00:00Z"); // Saturday
		const sun = new Date("2026-05-03T12:00:00Z"); // Sunday
		const mon = new Date("2026-05-04T12:00:00Z"); // Monday
		expect(isWeekendUtc(sat)).toBe(true);
		expect(isWeekendUtc(sun)).toBe(true);
		expect(isWeekendUtc(mon)).toBe(false);
	});

	it("extractSubject returns first line of multi-line message", () => {
		expect(extractSubject("feat: add x\n\nlong body\nmore body")).toBe(
			"feat: add x",
		);
		expect(extractSubject("single-line")).toBe("single-line");
		expect(extractSubject("")).toBe("");
	});

	it("renderStandupMd renders no-commits placeholder when byAuthor empty", () => {
		const md = renderStandupMd({
			projectName: "p",
			today: "2026-04-30",
			isoWeek: "2026-W18",
			byAuthor: new Map(),
			openBlockers: [],
			sprintTasks: [],
		});
		expect(md).toContain("_No commits in the last 24 hours._");
		expect(md).toContain("_No tasks in the current sprint List._");
		expect(md).toContain("_No open bugs._");
	});

	it("renderRetroMd shows ⚠ carryover spike when carryoverCount >= 3", () => {
		const md = renderRetroMd({
			projectName: "p",
			isoWeek: "2026-W18",
			committedTasks: 10,
			deliveredTasks: 6,
			carryoverCount: 4,
			newBugs: 2,
			closedBugs: 3,
			velocityWindow: [],
		});
		expect(md).toContain("⚠ Carryover spike");
		expect(md).toContain("4 tasks carried");
	});

	it("renderRetroMd does NOT show carryover spike when count < 3", () => {
		const md = renderRetroMd({
			projectName: "p",
			isoWeek: "2026-W18",
			committedTasks: 10,
			deliveredTasks: 8,
			carryoverCount: 2,
			newBugs: 1,
			closedBugs: 2,
			velocityWindow: [],
		});
		expect(md).not.toContain("⚠ Carryover spike");
	});
});
