import { mapProjectRow } from "./projects.controller";
import type { ProjectRow } from "./projects.service";

function makeRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: "11111111-1111-1111-1111-111111111111",
		organisation_id: "22222222-2222-2222-2222-222222222222",
		local_path: "/repos/sample",
		display_name: "Sample",
		git_remote_url: "git@github.com:Achitokun14/sample.git",
		scope_config: { mode: "root" },
		clickup_team_id: "TEAM1",
		clickup_space_id: "SPACE1",
		clickup_folder_id: "FOLDER1",
		list_ids: { open_work: "L1" } as any,
		custom_field_ids: {},
		task_index: { "commit:abc": "T1" },
		hook_secret: "supersecret_NEVER_LEAK",
		status: "active",
		last_synced_at: new Date("2026-04-30T00:00:00Z"),
		created_at: new Date("2026-04-29T00:00:00Z"),
		updated_at: new Date("2026-04-30T00:00:00Z"),
		clickup_doc_id: "DOC1",
		sprint_lists: { "2026-W18": "SL1" },
		backfill_state: { status: "done", processed: 10, total: 10 },
		template_status: "configured",
		git_default_branch: "main",
		git_remote_host: "github.com",
		git_remote_owner_repo: "Achitokun14/sample",
		last_seen_status_changes: [{ at: "2026-04-30", task_id: "T1" }],
		...overrides,
	};
}

describe("mapProjectRow (Bug 3 — controller exposes all 19 fields)", () => {
	it("exposes all 19 camelCase fields", () => {
		const out = mapProjectRow(makeRow());
		expect(Object.keys(out).sort()).toEqual(
			[
				"backfillState",
				"clickupDocId",
				"clickupFolderId",
				"clickupSpaceId",
				"clickupTeamId",
				"createdAt",
				"displayName",
				"gitDefaultBranch",
				"gitRemoteHost",
				"gitRemoteOwnerRepo",
				"gitRemoteUrl",
				"id",
				"lastSeenStatusChanges",
				"lastSyncedAt",
				"listIds",
				"localPath",
				"scopeConfig",
				"sprintLists",
				"status",
				"taskIndex",
				"templateStatus",
				"updatedAt",
			].sort(),
		);
	});

	it("never leaks hook_secret", () => {
		const out = mapProjectRow(makeRow());
		expect((out as any).hookSecret).toBeUndefined();
		expect((out as any).hook_secret).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain("supersecret_NEVER_LEAK");
	});

	it("coerces null sprint_lists / last_seen_status_changes to empty containers", () => {
		const out = mapProjectRow(
			makeRow({
				sprint_lists: null as any,
				last_seen_status_changes: null as any,
			}),
		);
		expect(out.sprintLists).toEqual({});
		expect(out.lastSeenStatusChanges).toEqual([]);
	});

	it("preserves backfill_state as a structured object", () => {
		const out = mapProjectRow(makeRow());
		expect(out.backfillState).toEqual({
			status: "done",
			processed: 10,
			total: 10,
		});
	});
});
