import { commitUrl } from "./commit-url";
import { parseGitRemote } from "./git-remote-parse";

const SHA = "7f76ae74a8b9";

describe("commitUrl", () => {
	it("GitHub uses /commit/", () => {
		const r = parseGitRemote(
			"https://github.com/Achitokun14/clickup-tracker-standalone.git",
		);
		expect(commitUrl(r, SHA)).toBe(
			`https://github.com/Achitokun14/clickup-tracker-standalone/commit/${SHA}`,
		);
	});

	it("GitLab uses /-/commit/", () => {
		const r = parseGitRemote("https://gitlab.com/group/sub/repo.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://gitlab.com/group/sub/repo/-/commit/${SHA}`,
		);
	});

	it("Self-hosted GitLab is detected via host pattern", () => {
		const r = parseGitRemote("https://gitlab.acme.org/team/api.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://gitlab.acme.org/team/api/-/commit/${SHA}`,
		);
	});

	it("Bitbucket Cloud uses /commits/ (plural)", () => {
		const r = parseGitRemote("https://bitbucket.org/owner/repo.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://bitbucket.org/owner/repo/commits/${SHA}`,
		);
	});

	it("Codeberg uses /commit/", () => {
		const r = parseGitRemote("https://codeberg.org/forks/cool.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://codeberg.org/forks/cool/commit/${SHA}`,
		);
	});

	it("Gitea pattern matches via subdomain hint", () => {
		const r = parseGitRemote("https://gitea.example.io/team/repo.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://gitea.example.io/team/repo/commit/${SHA}`,
		);
	});

	it("Bitbucket Server (with explicit hint) uses /projects/.../repos/.../commits/", () => {
		const r = parseGitRemote("https://stash.acme.io/MYPROJ/myrepo.git");
		expect(commitUrl(r, SHA, { kind: "bitbucket-server" })).toBe(
			`https://stash.acme.io/projects/MYPROJ/repos/myrepo/commits/${SHA}`,
		);
	});

	it("returns null when remote is null", () => {
		expect(commitUrl(null, SHA)).toBeNull();
	});

	it("returns null when sha is empty", () => {
		expect(commitUrl({ host: "github.com", ownerRepo: "a/b" }, "")).toBeNull();
	});

	it("falls back to /commit/ for unknown hosts", () => {
		const r = parseGitRemote("https://git.unknown.example/team/repo.git");
		expect(commitUrl(r, SHA)).toBe(
			`https://git.unknown.example/team/repo/commit/${SHA}`,
		);
	});
});
