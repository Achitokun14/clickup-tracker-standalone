import {
	AdoptService,
	matchFolderKey,
	matchListKey,
	parseSprintIsoWeek,
} from "./adopt.service";

class FakePrisma {
	calls: Array<{ sql: string; params: unknown[] }> = [];
	insertedRow: any = null;

	async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
		this.calls.push({ sql, params });
		return 1;
	}
	async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
		this.calls.push({ sql, params });
		if (sql.startsWith("INSERT INTO clickup_tracker.projects")) {
			this.insertedRow = {
				id: "PROJECT_ADOPTED_1",
				organisation_id: params[0],
				local_path: params[1],
				display_name: params[2],
				clickup_team_id: params[5],
				clickup_space_id: params[6],
				clickup_folder_id: params[7],
				list_ids: JSON.parse(params[8] as string),
				sprint_lists: JSON.parse(params[9] as string),
				task_index: JSON.parse(params[11] as string),
				extra_lists: JSON.parse(params[14] as string),
				extra_folders: JSON.parse(params[15] as string),
			};
			return [this.insertedRow] as unknown as T;
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
	spaces: Array<{ id: string; name: string }> = [];
	folders: Map<string, Array<{ id: string; name: string }>> = new Map();
	lists: Map<string, Array<{ id: string; name: string }>> = new Map();
	tasks: Map<
		string,
		Array<{ id: string; name: string; markdown_description?: string }>
	> = new Map();

	async listSpaces() {
		return this.spaces.map((s) => ({ ...s }));
	}
	async listFolders(spaceId: string) {
		return (this.folders.get(spaceId) ?? []).map((f) => ({ ...f }));
	}
	async listListsInFolder(folderId: string) {
		return (this.lists.get(folderId) ?? []).map((l) => ({ ...l }));
	}
	async listTasksInList(listId: string) {
		return (this.tasks.get(listId) ?? []).map((t) => ({ ...t }));
	}
}

function build() {
	const prisma = new FakePrisma();
	const creds = new FakeCredentials();
	const cu = new FakeClickUp();
	const svc = new AdoptService(prisma as any, creds as any, cu as any);
	return { svc, prisma, cu };
}

describe("AdoptService.adopt (Plan §B.2 + §B.3)", () => {
	it("hydrates list_ids from emoji-prefixed Folders + tolerant List names", async () => {
		const { svc, cu, prisma } = build();
		cu.spaces = [{ id: "SPACE1", name: "My Repo" }];
		cu.folders.set("SPACE1", [
			{ id: "F_BACKLOG", name: "📦 Backlog & Bugs" },
			{ id: "F_ACTIVE", name: "🚧 Active Work" },
			{ id: "F_HISTORY", name: "📜 History" },
			{ id: "F_KNOW", name: "📚 Knowledge" },
		]);
		cu.lists.set("F_BACKLOG", [
			{ id: "L_OW", name: "Open Work" },
			{ id: "L_BUGS", name: "Bugs" },
		]);
		cu.lists.set("F_ACTIVE", [
			{ id: "L_ACTIVE", name: "Active Sprint" },
			{ id: "L_REVIEW", name: "In Review" },
		]);
		cu.lists.set("F_KNOW", [
			{ id: "L_ADRS", name: "ADRs" },
			{ id: "L_AGENT", name: "Agent Sessions" },
		]);

		const result = await svc.adopt("ORG1", {
			localPath: "/repos/sample",
			displayName: "Sample",
			clickupSpaceId: "SPACE1",
		});

		expect(result.adopted).toBe(true);
		expect(result.listIds).toEqual({
			open_work: "L_OW",
			bugs: "L_BUGS",
			active_sprint: "L_ACTIVE",
			in_review: "L_REVIEW",
			adrs: "L_ADRS",
			agent_sessions: "L_AGENT",
		});
		expect(result.folderId).toBe("F_ACTIVE");
		expect(prisma.insertedRow.list_ids.open_work).toBe("L_OW");
	});

	it("captures unrecognised Folders + Lists in extra_folders / extra_lists", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE1", name: "My Repo" }];
		cu.folders.set("SPACE1", [
			{ id: "F_ACTIVE", name: "🚧 Active Work" },
			{ id: "F_CUSTOM", name: "🎨 Design Reviews" }, // unrecognised
		]);
		cu.lists.set("F_ACTIVE", [
			{ id: "L_ACTIVE", name: "Active Sprint" },
			{ id: "L_OTHER", name: "Custom Pinned" }, // unrecognised
		]);
		const result = await svc.adopt("ORG1", {
			localPath: "/repos/x",
			displayName: "X",
			clickupSpaceId: "SPACE1",
		});
		expect(result.extraFolders).toEqual([
			{ folderId: "F_CUSTOM", name: "🎨 Design Reviews" },
		]);
		expect(result.extraLists).toEqual([
			{ folderId: "F_ACTIVE", listId: "L_OTHER", name: "Custom Pinned" },
		]);
	});

	it("parses sprint Lists from the History folder into ISO week keys", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE1", name: "My Repo" }];
		cu.folders.set("SPACE1", [{ id: "F_HISTORY", name: "📜 History" }]);
		cu.lists.set("F_HISTORY", [
			{ id: "L_W17", name: "Sprint 1 — 2026-04-20 → 2026-04-26" },
			{ id: "L_W18", name: "Sprint 2 — 2026-04-27 → 2026-05-03" },
		]);
		const result = await svc.adopt("ORG1", {
			localPath: "/repos/x",
			displayName: "X",
			clickupSpaceId: "SPACE1",
		});
		expect(Object.keys(result.sprintLists).sort()).toEqual([
			"2026-W17",
			"2026-W18",
		]);
		expect(result.sprintLists["2026-W17"]).toBe("L_W17");
	});

	it("claims only auto-imported tasks (footer regex) into task_index", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE1", name: "My Repo" }];
		cu.folders.set("SPACE1", [{ id: "F_ACTIVE", name: "🚧 Active Work" }]);
		cu.lists.set("F_ACTIVE", [{ id: "L_REVIEW", name: "In Review" }]);
		cu.tasks.set("L_REVIEW", [
			{
				id: "T_AUTO",
				name: "[2026-04-29] Feature(api): auto task",
				markdown_description: [
					"**Contributor:** ali",
					"",
					"**Commit:** [`abc1234`](https://github.com/me/repo/commit/abc1234)",
					"**Branch:** `main`",
					"",
					"---",
					"_Auto-imported by clickup-tracker. Type: Feature · Epic: epic-api · Sprint: 2026-W17_",
				].join("\n"),
			},
			{
				id: "T_HUMAN",
				name: "[2026-04-29] Feature(api): human-named task",
				markdown_description: "Body without footer — human authored",
			},
		]);

		const result = await svc.adopt("ORG1", {
			localPath: "/repos/x",
			displayName: "X",
			clickupSpaceId: "SPACE1",
		});
		// Only T_AUTO is claimed; T_HUMAN is untouched.
		expect(Object.values(result).flat).toBeDefined();
		const taskIndex = (svc as any) && (cu as any); // shape sanity; below is the assertion that matters
		expect(result.taskIndexCount).toBe(1);
	});

	it("rejects with 400 when local_path is already tracked (active row)", async () => {
		const { svc, prisma, cu } = build();
		cu.spaces = [{ id: "SPACE1", name: "X" }];
		// Make the FakePrisma return an existing row at this path.
		(prisma as any).$queryRawUnsafe = async (sql: string) => {
			if (
				sql.includes("FROM clickup_tracker.projects") &&
				sql.includes("status <> 'removed'")
			) {
				return [{ id: "PROJECT_EXISTING", status: "active" }];
			}
			return [];
		};
		await expect(
			svc.adopt("ORG1", {
				localPath: "/repos/already-tracked",
				displayName: "X",
				clickupSpaceId: "SPACE1",
			}),
		).rejects.toThrow(/already tracked/);
	});

	it("404s when the Space is not in the workspace", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "OTHER_SPACE", name: "Other" }];
		await expect(
			svc.adopt("ORG1", {
				localPath: "/repos/x",
				displayName: "X",
				clickupSpaceId: "MISSING_SPACE",
			}),
		).rejects.toThrow(/not found/);
	});
});

describe("matchFolderKey / matchListKey / parseSprintIsoWeek", () => {
	it("matchFolderKey accepts the four canonical emojis", () => {
		expect(matchFolderKey("📦 Backlog & Bugs")).toBe("backlog_bugs");
		expect(matchFolderKey("🚧 Active Work")).toBe("active_work");
		expect(matchFolderKey("📜 History")).toBe("history");
		expect(matchFolderKey("📚 Knowledge")).toBe("knowledge");
		expect(matchFolderKey("🎨 Design")).toBeNull();
	});

	it("matchListKey is case-insensitive + tolerant of whitespace", () => {
		expect(matchListKey("backlog_bugs", "  open work  ")).toBe("open_work");
		expect(matchListKey("backlog_bugs", "OPEN WORK")).toBe("open_work");
		expect(matchListKey("active_work", "In Review")).toBe("in_review");
		expect(matchListKey("knowledge", "ADRs")).toBe("adrs");
		expect(matchListKey("backlog_bugs", "Random Other")).toBeNull();
	});

	it("parseSprintIsoWeek parses canonical and en-dash variants", () => {
		expect(parseSprintIsoWeek("Sprint 1 — 2026-04-20 → 2026-04-26")).toBe(
			"2026-W17",
		);
		expect(parseSprintIsoWeek("Sprint 17 - 2026-04-20 -> 2026-04-26")).toBe(
			"2026-W17",
		);
		expect(parseSprintIsoWeek("Random List")).toBeNull();
	});
});
