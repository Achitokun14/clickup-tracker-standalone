import { parseGitRemote } from "./git-remote-parse";

describe("parseGitRemote", () => {
	it.each([
		[
			"https://github.com/Achitokun14/clickup-tracker-standalone.git",
			"github.com",
			"Achitokun14/clickup-tracker-standalone",
		],
		[
			"https://github.com/Achitokun14/clickup-tracker-standalone",
			"github.com",
			"Achitokun14/clickup-tracker-standalone",
		],
		[
			"git@github.com:Achitokun14/clickup-tracker-standalone.git",
			"github.com",
			"Achitokun14/clickup-tracker-standalone",
		],
		["git@gitlab.com:group/sub/repo.git", "gitlab.com", "group/sub/repo"],
		[
			"https://gitlab.example.org/team-a/svc/api.git",
			"gitlab.example.org",
			"team-a/svc/api",
		],
		["https://bitbucket.org/owner/repo.git", "bitbucket.org", "owner/repo"],
		["https://codeberg.org/forks/cool.git", "codeberg.org", "forks/cool"],
		["https://gitea.example.io/team/repo.git", "gitea.example.io", "team/repo"],
		[
			"ssh://git@gitea.example.io/team/repo.git",
			"gitea.example.io",
			"team/repo",
		],
		[
			"https://user:tok@github.com/Achitokun14/repo.git",
			"github.com",
			"Achitokun14/repo",
		],
	])("%s → %s / %s", (url, host, ownerRepo) => {
		expect(parseGitRemote(url)).toEqual({ host, ownerRepo });
	});

	it.each([
		"",
		"   ",
		"not-a-url",
		"file:///home/me/repo",
		"github:short-handle",
	])("returns null for %p", (url) => {
		expect(parseGitRemote(url)).toBeNull();
	});

	it("lowercases the host", () => {
		expect(parseGitRemote("git@GitHub.com:Owner/repo.git")?.host).toBe(
			"github.com",
		);
	});
});
