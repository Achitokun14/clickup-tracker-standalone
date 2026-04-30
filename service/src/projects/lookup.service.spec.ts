import { LookupService } from "./lookup.service";

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
	const creds = new FakeCredentials();
	const cu = new FakeClickUp();
	const svc = new LookupService(cu as any, creds as any);
	return { svc, cu };
}

describe("LookupService.lookup (Plan §B.1)", () => {
	it("returns empty matches for an empty workspace", async () => {
		const { svc } = build();
		const out = await svc.lookup({ orgId: "ORG1", displayName: "Anything" });
		expect(out).toEqual([]);
	});

	it("returns medium match on case-insensitive displayName", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "My Repo" }];
		const out = await svc.lookup({ orgId: "ORG1", displayName: "my repo" });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			spaceId: "SPACE_A",
			strength: "medium",
		});
	});

	it("returns medium match on owner/repo slug", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "achitokun14-clickup-tracker" }];
		const out = await svc.lookup({
			orgId: "ORG1",
			displayName: "Different Name",
			gitRemoteUrl: "https://github.com/Achitokun14/clickup-tracker.git",
		});
		expect(out).toHaveLength(1);
		expect(out[0].strength).toBe("medium");
		expect(out[0].reason).toContain("owner/repo slug");
	});

	it("returns weak match on kebab substring", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "team-platform-tracker-shared" }];
		const out = await svc.lookup({
			orgId: "ORG1",
			displayName: "platform tracker",
		});
		expect(out).toHaveLength(1);
		expect(out[0].strength).toBe("weak");
	});

	it("scanFooters=true upgrades to strong when remote URL footer matches", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "Unrelated Name" }];
		cu.folders.set("SPACE_A", [{ id: "F1", name: "🚧 Active Work" }]);
		cu.lists.set("F1", [{ id: "L1", name: "In Review" }]);
		cu.tasks.set("L1", [
			{
				id: "T1",
				name: "[2026-04-29] Feature(api): bootstrap",
				markdown_description:
					"Some body text\n\nRemote: https://github.com/me/repo.git\nFooter: ...",
			},
		]);
		const out = await svc.lookup({
			orgId: "ORG1",
			displayName: "Other Display",
			gitRemoteUrl: "https://github.com/me/repo.git",
			scanFooters: true,
		});
		expect(out).toHaveLength(1);
		expect(out[0].strength).toBe("strong");
	});

	it("scanFooters=false (default) does NOT fan out to listFolders/listTasks", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "Unrelated Name" }];
		// No folders configured — if scanFooters=true the service would try to fetch.
		const calls: string[] = [];
		const origListFolders = cu.listFolders.bind(cu);
		(cu as any).listFolders = async (...a: unknown[]) => {
			calls.push("listFolders");
			return origListFolders(a[0] as string);
		};
		await svc.lookup({
			orgId: "ORG1",
			displayName: "Other Display",
			gitRemoteUrl: "https://github.com/me/repo.git",
		});
		expect(calls).toHaveLength(0);
	});

	it("caches results within 60s window per (orgId, displayName, remote)", async () => {
		const { svc, cu } = build();
		cu.spaces = [{ id: "SPACE_A", name: "My Repo" }];
		const calls: number[] = [];
		const orig = cu.listSpaces.bind(cu);
		(cu as any).listSpaces = async () => {
			calls.push(1);
			return orig();
		};
		await svc.lookup({ orgId: "ORG1", displayName: "My Repo" });
		await svc.lookup({ orgId: "ORG1", displayName: "My Repo" });
		expect(calls).toHaveLength(1);
	});
});
