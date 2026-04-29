import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GitHistoryExtractor } from "./git-history.extractor";

const execFile = promisify(execFileCb);

/**
 * Builds a real on-disk git repo with deterministic commits across two
 * branches and exercises the extractor against it. Uses GIT_*_DATE env vars
 * to fix author/committer timestamps so sprint bucketing is deterministic.
 */
describe("GitHistoryExtractor", () => {
	let repo: string;
	let svc: GitHistoryExtractor;

	beforeAll(async () => {
		repo = await mkdtemp(join(tmpdir(), "cup-githist-"));
		svc = new GitHistoryExtractor();

		const env = {
			...process.env,
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.org",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.org",
		};

		async function run(args: string[], extraEnv: Record<string, string> = {}) {
			await execFile("git", args, { cwd: repo, env: { ...env, ...extraEnv } });
		}

		async function commit(
			file: string,
			content: string,
			msg: string,
			isoDate: string,
			who?: { name: string; email: string },
		) {
			const fullPath = join(repo, file);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, content);
			await run(["add", file]);
			const userEnv = who
				? {
						GIT_AUTHOR_NAME: who.name,
						GIT_AUTHOR_EMAIL: who.email,
						GIT_COMMITTER_NAME: who.name,
						GIT_COMMITTER_EMAIL: who.email,
					}
				: {};
			await run(["commit", "-m", msg, "--no-gpg-sign"], {
				GIT_AUTHOR_DATE: isoDate,
				GIT_COMMITTER_DATE: isoDate,
				...userEnv,
			});
		}

		await run(["init", "-q", "--initial-branch=main"]);
		await run(["config", "user.email", "alice@example.org"]);
		await run(["config", "user.name", "Alice"]);

		// Commit 1 — Mon of ISO 2024-W02 (2024-01-08)
		await commit(
			"README.md",
			"# repo\n",
			"feat(init): scaffold readme",
			"2024-01-08T10:00:00Z",
		);
		// Commit 2 — Tue of same week
		await commit(
			"README.md",
			"# repo\n\nhello\n",
			"fix: typo in README",
			"2024-01-09T10:00:00Z",
		);
		// Commit 3 — Sat of same week
		await commit(
			"LICENSE",
			"MIT\n",
			"docs: add license",
			"2024-01-13T10:00:00Z",
		);
		// Commit 4 — next ISO week (2024-W03), different author
		await commit(
			"src/a.ts",
			"export const a = 1;\n",
			"feat(api): add a",
			"2024-01-16T10:00:00Z",
			{ name: "Bob", email: "bob@example.org" },
		);
		// Commit 5 — non-conventional
		await commit(
			"src/a.ts",
			"export const a = 2;\n",
			"Update value",
			"2024-01-17T10:00:00Z",
		);

		await run([
			"remote",
			"add",
			"origin",
			"https://github.com/example/test.git",
		]);
	}, 30_000);

	afterAll(async () => {
		if (repo) await rm(repo, { recursive: true, force: true });
	});

	it("extracts every commit in chronological asc order", async () => {
		const ext = await svc.extract(repo);
		expect(ext.commits.length).toBe(5);
		const dates = ext.commits.map((c) => c.author.date);
		const sorted = [...dates].sort();
		expect(dates).toEqual(sorted);
	});

	it("buckets commits into ISO weeks with global sprint ordinals", async () => {
		const ext = await svc.extract(repo);
		expect(ext.sprints.length).toBe(2);
		expect(ext.sprints[0].key).toBe("2024-W02");
		expect(ext.sprints[0].ordinal).toBe(1);
		expect(ext.sprints[0].commitCount).toBe(3);
		expect(ext.sprints[1].key).toBe("2024-W03");
		expect(ext.sprints[1].ordinal).toBe(2);
		expect(ext.sprints[1].commitCount).toBe(2);
		expect(ext.sprints[0].startDate).toBe("2024-01-08");
		expect(ext.sprints[0].endDate).toBe("2024-01-14");
	});

	it("classifies type from conventional prefixes and falls back to keyword heuristics", async () => {
		const ext = await svc.extract(repo);
		const subjectsByType = new Map(ext.commits.map((c) => [c.subject, c.type]));
		expect(subjectsByType.get("feat(init): scaffold readme")).toBe("Feature");
		expect(subjectsByType.get("fix: typo in README")).toBe("Bug Fix");
		expect(subjectsByType.get("docs: add license")).toBe("Docs");
		expect(subjectsByType.get("feat(api): add a")).toBe("Feature");
		// Non-conventional "Update value" → BGMT keyword fallback chooses Feature ("update" word? actually "improve|enhance|new" — "update" isn't in the list → Chore).
		expect(subjectsByType.get("Update value")).toBe("Chore");
	});

	it("captures file change statuses with additions/deletions", async () => {
		const ext = await svc.extract(repo);
		const c4 = ext.commits.find((c) => c.subject === "feat(api): add a");
		expect(c4).toBeDefined();
		expect(c4!.filesChanged.length).toBe(1);
		expect(c4!.filesChanged[0].path).toBe("src/a.ts");
		expect(c4!.filesChanged[0].additions).toBe(1);
		expect(c4!.filesChanged[0].deletions).toBe(0);
	});

	it("captures multiple authors across commits", async () => {
		const ext = await svc.extract(repo);
		const authors = new Set(ext.commits.map((c) => c.author.email));
		expect(authors.has("alice@example.org")).toBe(true);
		expect(authors.has("bob@example.org")).toBe(true);
	});

	it("parses the remote url and resolves default branch", async () => {
		const ext = await svc.extract(repo);
		expect(ext.remote.url).toBe("https://github.com/example/test.git");
		expect(ext.remote.host).toBe("github.com");
		expect(ext.remote.ownerRepo).toBe("example/test");
		// No origin/HEAD set; falls back to "main" because we initialised with that branch.
		expect(["main", "master"]).toContain(ext.defaultBranch);
	});

	it("returns truncated=false when commit count is well below the cap", async () => {
		const ext = await svc.extract(repo);
		expect(ext.truncated).toBe(false);
	});

	it("handles a repo with no remote and no commits", async () => {
		const empty = await mkdtemp(join(tmpdir(), "cup-empty-"));
		try {
			await execFile("git", ["init", "-q", "--initial-branch=main"], {
				cwd: empty,
			});
			const ext = await svc.extract(empty);
			expect(ext.commits.length).toBe(0);
			expect(ext.sprints.length).toBe(0);
			expect(ext.remote.url).toBeNull();
			expect(ext.truncated).toBe(false);
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});
