import {
	planRepo,
	LIST_NAMES,
	CUSTOM_FIELDS,
	TASK_SOURCE,
	mapInlineStatus,
} from "./hierarchy";
import type { RepoEntry, RepoExtract } from "./types";

function makeRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
	return {
		path: "/home/u/Desktop/sample",
		name: "sample",
		displayName: "Sample",
		stack: "TS",
		hasReadme: true,
		hasChangelog: false,
		stateFiles: [],
		isBackup: false,
		excluded: false,
		...overrides,
	};
}

function makeExt(overrides: Partial<RepoExtract> = {}): RepoExtract {
	return {
		readme: { title: "Sample", excerpt: "Sample readme excerpt." },
		changelogEntries: [],
		stateEntries: [],
		todos: [],
		todosOverflow: 0,
		lastCommitISO: "2026-04-27T00:00:00Z",
		pkgMeta: null,
		...overrides,
	};
}

describe("planRepo", () => {
	it("emits one overview task per repo with custom fields populated", () => {
		const plan = planRepo(makeRepo(), makeExt());
		expect(plan.tasks).toHaveLength(1);
		expect(plan.tasks[0].key).toBe("overview");
		expect(plan.tasks[0].list).toBe("overview");
		expect(plan.tasks[0].custom_fields).toMatchObject({
			"Repo path": "/home/u/Desktop/sample",
			Stack: "TS",
			Source: TASK_SOURCE,
		});
	});

	it("emits one task per TODO/FIXME match", () => {
		const todos = [
			{ file: "src/a.ts", line: 1, marker: "TODO", text: "first" },
			{ file: "src/b.ts", line: 5, marker: "FIXME", text: "second" },
		];
		const plan = planRepo(makeRepo(), makeExt({ todos }));
		const openWork = plan.tasks.filter((t) => t.list === "open_work");
		expect(openWork).toHaveLength(2);
		expect(openWork[0].key).toBe("todo:src/a.ts:1");
		expect(openWork[1].name).toContain("FIXME: second");
	});

	it("emits an overflow task when todosOverflow > 0", () => {
		const plan = planRepo(makeRepo(), makeExt({ todosOverflow: 17 }));
		const overflow = plan.tasks.find((t) => t.key === "todo:overflow");
		expect(overflow).toBeDefined();
		expect(overflow!.name).toContain("+17");
	});

	it("collapses CHANGELOG entries into a single History task with comments", () => {
		const plan = planRepo(
			makeRepo(),
			makeExt({
				changelogEntries: [
					{ heading: "v1.1.0", body: "first body" },
					{ heading: "v1.0.0", body: "second body" },
				],
			}),
		);
		const history = plan.tasks.find((t) => t.list === "history");
		expect(history).toBeDefined();
		expect(history!.comments).toHaveLength(2);
		expect(history!.comments![0]).toContain("v1.1.0");
	});

	it("emits one Open Work task per state entry, keyed by source:bucket:index", () => {
		const plan = planRepo(
			makeRepo(),
			makeExt({
				stateEntries: [
					{
						source: "STATE.json",
						bucket: "pending",
						index: 0,
						preview: "Do thing",
						raw: { x: 1 },
					},
					{
						source: "STATE.json",
						bucket: "next",
						index: 0,
						preview: "Next thing",
						raw: { y: 2 },
					},
				],
			}),
		);
		const stateTasks = plan.tasks.filter((t) => t.key.startsWith("state:"));
		expect(stateTasks).toHaveLength(2);
		expect(stateTasks[0].key).toBe("state:STATE.json:pending:0");
		expect(stateTasks[1].name).toContain("[next]");
	});

	it("emits the canonical 3-list mapping", () => {
		const plan = planRepo(makeRepo(), makeExt());
		expect(plan.lists).toEqual(LIST_NAMES);
	});
});

describe("constants", () => {
	it("exposes the 6 custom-field schema entries", () => {
		expect(CUSTOM_FIELDS.map((f) => f.name)).toEqual([
			"Repo path",
			"Stack",
			"Deploy URL",
			"Port",
			"Last commit",
			"Source",
		]);
	});
});

describe("mapInlineStatus", () => {
	it("maps the 7-status workflow's terminal/closed states to 'complete'", () => {
		expect(mapInlineStatus("Done")).toBe("complete");
		expect(mapInlineStatus("done")).toBe("complete");
		expect(mapInlineStatus("Archived")).toBe("complete");
		expect(mapInlineStatus("Closed")).toBe("complete");
		expect(mapInlineStatus("Won't Fix")).toBe("complete");
		expect(mapInlineStatus("Wont Fix")).toBe("complete");
		expect(mapInlineStatus("complete")).toBe("complete");
	});

	it("maps every other status to 'to do' (the inline-fallback default)", () => {
		expect(mapInlineStatus("Backlog")).toBe("to do");
		expect(mapInlineStatus("To Do")).toBe("to do");
		expect(mapInlineStatus("In Progress")).toBe("to do");
		expect(mapInlineStatus("In Review")).toBe("to do");
		expect(mapInlineStatus("Blocked")).toBe("to do");
		expect(mapInlineStatus("Reported")).toBe("to do");
		expect(mapInlineStatus("Verifying")).toBe("to do");
		expect(mapInlineStatus("anything-else")).toBe("to do");
		expect(mapInlineStatus("")).toBe("to do");
	});
});
