import type {
	CommitRecord,
	GitHistoryExtract,
} from "../extractors/git-history.extractor";
import {
	BUG_STATUSES,
	planSpace,
	SPACE_STATUSES,
	sprintListKey,
} from "./hierarchy";
import type { RepoEntry, RepoExtract } from "./types";

function makeRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
	return {
		path: "/repos/sample",
		name: "sample",
		displayName: "Sample Repo",
		stack: "TS",
		hasReadme: true,
		hasChangelog: true,
		stateFiles: [],
		isBackup: false,
		excluded: false,
		...overrides,
	};
}

function makeExtract(overrides: Partial<RepoExtract> = {}): RepoExtract {
	return {
		readme: { title: "Sample", excerpt: "# Sample\n\n## Setup\nrun `npm i`." },
		changelogEntries: [
			{ heading: "[0.1.0] - 2026-04-01", body: "- first cut" },
		],
		stateEntries: [],
		todos: [],
		todosOverflow: 0,
		lastCommitISO: "2026-04-15T10:00:00Z",
		pkgMeta: { name: "sample", version: "0.1.0" },
		...overrides,
	};
}

function makeCommit(over: Partial<CommitRecord>): CommitRecord {
	const author = over.author ?? {
		name: "Achraf",
		email: "achrafalaoui14@gmail.com",
		date: "2026-04-14T12:00:00Z",
	};
	return {
		sha: "abc1234567890abcdef1234567890abcdef1234",
		parents: [],
		author,
		committer: { ...author, date: author.date },
		refs: ["main", "origin/main"],
		branch: "main",
		subject: "feat(api): new endpoint",
		body: "",
		type: "Feature",
		scope: "api",
		filesChanged: [
			{ path: "src/api.ts", additions: 30, deletions: 5, status: "M" },
		],
		isMergeCommit: false,
		sprintKey: "2026-W16",
		sprintOrdinal: 1,
		sprintRange: { startDate: "2026-04-13", endDate: "2026-04-19" },
		...over,
	};
}

function makeHistory(
	overrides: Partial<GitHistoryExtract> = {},
): GitHistoryExtract {
	const commits = overrides.commits ?? [makeCommit({})];
	return {
		commits,
		sprints: overrides.sprints ?? [
			{
				key: "2026-W16",
				ordinal: 1,
				startDate: "2026-04-13",
				endDate: "2026-04-19",
				commitCount: commits.length,
			},
		],
		remote: overrides.remote ?? {
			url: "git@github.com:Achitokun14/sample.git",
			host: "github.com",
			ownerRepo: "Achitokun14/sample",
		},
		defaultBranch: overrides.defaultBranch ?? "main",
		truncated: overrides.truncated ?? false,
	};
}

describe("planSpace", () => {
	it("emits the static folder/list scaffold + one List per sprint", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		expect(plan.folders.map((f) => f.name)).toEqual([
			"📦 Backlog & Bugs",
			"🚧 Active Work",
			"📜 History",
			"📚 Knowledge",
		]);
		const history = plan.folders.find((f) => f.name === "📜 History");
		expect(history?.lists).toEqual([
			{ key: "sprint:2026-W16", name: "Sprint 1 — 2026-04-13 → 2026-04-19" },
		]);
		expect(plan.statuses).toBe(SPACE_STATUSES);
		expect(
			plan.folders.flatMap((f) => f.lists).find((l) => l.key === "bugs")
				?.statusOverrides,
		).toBe(BUG_STATUSES);
	});

	it("plans one commit task per commit, on the correct sprint List", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		const commitTasks = plan.tasks.filter((t) => t.key.startsWith("commit:"));
		expect(commitTasks.length).toBe(1);
		const t = commitTasks[0];
		expect(t.listKey).toBe(sprintListKey("2026-W16"));
		expect(t.status).toBe("Done");
		expect(t.name).toBe("[2026-04-14] Feature(api): new endpoint");
		expect(t.priority).toBe(3); // Normal for Feature
		expect(t.tags).toEqual(expect.arrayContaining(["type:feature", "api"]));
		expect(t.startDateMs).toBe(Date.parse("2026-04-14T12:00:00Z"));
		expect(t.dueDateMs).toBe(Date.parse("2026-04-14T12:00:00Z"));
		expect(t.points).toBe(1);
		expect(t.timeEstimateMs && t.timeEstimateMs > 0).toBe(true);
		expect(t.markdown_content).toContain("achrafalaoui14@gmail.com");
		expect(t.markdown_content).toContain(
			"https://github.com/Achitokun14/sample/commit/abc1234",
		);
	});

	it("routes branch-null + refs-empty commits to the sprint List (Bug 1, layer 3)", () => {
		// Plan §A.1 layer 3: when a stale post-commit hook ships no branch and
		// daemon-side synth somehow misses, the planner treats this as
		// default-branch (the overwhelmingly likely truth on a developer's
		// local repo) instead of dumping the commit into In Review.
		const orphan = makeCommit({
			sha: "0".repeat(40),
			subject: "feat: orphan branch info",
			branch: null,
			refs: [],
			sprintKey: "2026-W16",
		});
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ commits: [orphan] }),
		);
		const t = plan.tasks.find((t) => t.key === `commit:${"0".repeat(40)}`);
		expect(t?.status).toBe("Done");
		expect(t?.listKey).toBe(sprintListKey("2026-W16"));
	});

	it("routes non-default-branch commits to In Review", () => {
		const featBranch = makeCommit({
			sha: "f".repeat(40),
			subject: "feat(ui): wip",
			scope: "ui",
			branch: "feat/wip",
			refs: ["feat/wip"],
			sprintKey: "2026-W16",
		});
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ commits: [featBranch] }),
		);
		const t = plan.tasks.find((t) => t.key === `commit:${"f".repeat(40)}`);
		expect(t?.status).toBe("In Review");
		expect(t?.listKey).toBe("in_review");
	});

	it("creates Bug tasks for FIXME/BUG markers, Open Work for TODOs", () => {
		const ext = makeExtract({
			todos: [
				{ file: "src/a.ts", line: 10, marker: "TODO", text: "wire it up" },
				{ file: "src/b.ts", line: 22, marker: "FIXME", text: "null deref" },
			],
		});
		const plan = planSpace(makeRepo(), ext, makeHistory());
		const todo = plan.tasks.find((t) => t.key === "todo:src/a.ts:10");
		const bug = plan.tasks.find((t) => t.key === "bug:src/b.ts:22");
		expect(todo?.listKey).toBe("open_work");
		expect(todo?.status).toBe("Backlog");
		expect(bug?.listKey).toBe("bugs");
		expect(bug?.status).toBe("Reported");
		expect(bug?.priority).toBe(2); // High
	});

	it("emits the truncation warning task when history is truncated", () => {
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ truncated: true }),
		);
		const warn = plan.tasks.find((t) => t.key === "warn:history-truncated");
		expect(warn).toBeDefined();
		expect(warn?.listKey).toBe("open_work");
		expect(warn?.name).toContain("History truncated");
	});

	it("creates file-level subtasks for high-impact commits", () => {
		const big = makeCommit({
			sha: "1".repeat(40),
			subject: "refactor(core): split modules",
			scope: "core",
			type: "Refactor",
			filesChanged: [
				{ path: "a.ts", additions: 100, deletions: 10, status: "M" },
				{ path: "b.ts", additions: 80, deletions: 5, status: "M" },
				{ path: "c.ts", additions: 50, deletions: 2, status: "M" },
				{ path: "d.ts", additions: 20, deletions: 1, status: "M" },
			],
		});
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ commits: [big] }),
		);
		const subtasks = plan.tasks.filter((t) =>
			t.key.startsWith(`commit:${"1".repeat(40)}:file:`),
		);
		expect(subtasks.length).toBe(4);
		expect(
			subtasks.every((t) => t.parentKey === `commit:${"1".repeat(40)}`),
		).toBe(true);
		// Sorted by churn → a.ts must be first.
		expect(subtasks[0].key.endsWith(":file:a.ts")).toBe(true);
	});

	it("detects ADR files as Knowledge → ADRs tasks", () => {
		const adrCommit = makeCommit({
			sha: "a".repeat(40),
			subject: "docs(adr): pick postgres",
			filesChanged: [
				{
					path: "docs/adr/0001-pick-postgres.md",
					additions: 40,
					deletions: 0,
					status: "A",
				},
			],
		});
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ commits: [adrCommit] }),
		);
		const adr = plan.tasks.find((t) => t.key.startsWith("adr:"));
		expect(adr).toBeDefined();
		expect(adr?.listKey).toBe("adrs");
		expect(adr?.tags).toEqual(expect.arrayContaining(["adr"]));
	});

	it("emits the canonical Handbook pages with seeded Setup + Changelog content", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		expect(plan.doc.name).toBe("Sample Repo Handbook");
		// Plan §G.3 + §I.5 — original 5 + auto-managed Contributors /
		// Architecture / Dashboard / Ownership.
		expect(plan.doc.pages.map((p) => p.name)).toEqual([
			"Overview",
			"Setup",
			"Conventions",
			"Changelog",
			"Agent Prompt Log",
			"Contributors",
			"Architecture",
			"Dashboard",
			"Ownership",
		]);
		const setup = plan.doc.pages.find((p) => p.name === "Setup");
		expect(setup?.markdown).toContain("npm i");
		const changelog = plan.doc.pages.find((p) => p.name === "Changelog");
		expect(changelog?.markdown).toContain("[0.1.0]");
	});

	it("includes static + dynamic tags, sorted, deduplicated", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		expect(plan.tags).toEqual([...new Set(plan.tags)].sort());
		expect(plan.tags).toEqual(
			expect.arrayContaining([
				"frontend",
				"backend",
				"type:feature",
				"source:human",
			]),
		);
	});

	it("emits default Views per List (Active Sprint gets Board+Workload+Gantt)", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		const activeViews = plan.views.filter((v) => v.listKey === "active_sprint");
		expect(activeViews.map((v) => v.type).sort()).toEqual([
			"board",
			"gantt",
			"workload",
		]);
		// Sprint Lists get Board + Calendar.
		const sprintViews = plan.views.filter((v) =>
			v.listKey.startsWith("sprint:"),
		);
		expect(sprintViews.map((v) => v.type).sort()).toEqual([
			"board",
			"calendar",
		]);
	});

	it("falls back to inline-fallback templateStatus + multipleAssignees=true", () => {
		const plan = planSpace(makeRepo(), makeExtract(), makeHistory());
		expect(plan.templateStatus).toBe("inline-fallback");
		expect(plan.multipleAssignees).toBe(true);
	});

	it("handles an empty-history repo: emits the scaffold but no commit/sprint tasks", () => {
		// Plan §22 step 14: a freshly `git init`-ed repo backfills cleanly —
		// Space + folders + lists + Doc + views all present, just no commit
		// tasks and no per-sprint Lists.
		const plan = planSpace(
			makeRepo(),
			makeExtract(),
			makeHistory({ commits: [], sprints: [] }),
		);
		// Static scaffold still present.
		expect(plan.folders.map((f) => f.name)).toEqual([
			"📦 Backlog & Bugs",
			"🚧 Active Work",
			"📜 History",
			"📚 Knowledge",
		]);
		// No sprint-keyed lists nested under History.
		const historyFolder = plan.folders.find((f) => f.name === "📜 History")!;
		expect(historyFolder.lists).toHaveLength(0);
		// No commit-keyed tasks.
		expect(plan.tasks.filter((t) => t.key.startsWith("commit:"))).toHaveLength(
			0,
		);
		// Doc still emitted (5 original + 4 auto-managed handbook pages).
		expect(plan.doc.pages).toHaveLength(9);
		// No truncation warning.
		expect(
			plan.tasks.find((t) => t.key === "warn:history-truncated"),
		).toBeUndefined();
	});
});
