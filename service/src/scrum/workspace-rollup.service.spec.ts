import {
	renderActiveProjectsMd,
	renderHotspotsMd,
	renderWorkspaceContributorsMd,
} from "./workspace-rollup.service";

describe("renderActiveProjectsMd", () => {
	it("returns the empty placeholder", () => {
		expect(renderActiveProjectsMd([])).toContain("No active projects");
	});

	it("renders trend dot-separated and ISO-truncated last sync", () => {
		const md = renderActiveProjectsMd([
			{
				display_name: "alpha",
				last_synced_at: new Date("2026-05-02T11:23:45Z"),
				velocity_window: [
					{ iso_week: "2026-W17", committed_tasks: 8 },
					{ iso_week: "2026-W18", committed_tasks: 11 },
				],
			},
		]);
		expect(md).toContain("| alpha | 8 · 11 | 2026-05-02 11:23 UTC |");
	});

	it("renders dash when velocity_window null/empty + when last_synced null", () => {
		const md = renderActiveProjectsMd([
			{ display_name: "beta", last_synced_at: null, velocity_window: null },
		]);
		expect(md).toContain("| beta | — | — UTC |");
	});
});

describe("renderHotspotsMd", () => {
	it("returns the empty placeholder", () => {
		expect(renderHotspotsMd([])).toContain("No hotspots");
	});

	it("renders rows with bigint→Number coercion", () => {
		const md = renderHotspotsMd([
			{ display_name: "alpha", path: "src/foo.ts", churn: 12n as any },
		]);
		expect(md).toContain("| alpha | `src/foo.ts` | 12 |");
	});
});

describe("renderWorkspaceContributorsMd", () => {
	it("returns the empty placeholder", () => {
		expect(renderWorkspaceContributorsMd([])).toContain("No contributors yet");
	});

	it("renders github profile link when github_login present", () => {
		const md = renderWorkspaceContributorsMd([
			{
				email: "alice@x.com",
				github_login: "alice",
				commits: 50n as any,
				projects: 3n as any,
			},
		]);
		expect(md).toContain("[alice](https://github.com/alice)");
		expect(md).toContain("alice@x.com");
		expect(md).toContain("| 50 | 3 |");
	});

	it("falls back to email when no github_login", () => {
		const md = renderWorkspaceContributorsMd([
			{
				email: "ext@nowhere.io",
				github_login: null,
				commits: 1n as any,
				projects: 1n as any,
			},
		]);
		expect(md).not.toContain("github.com/");
		expect(md).toContain("`ext@nowhere.io`");
	});
});
