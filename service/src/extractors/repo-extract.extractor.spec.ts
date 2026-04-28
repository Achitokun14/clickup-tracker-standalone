import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseChangelog, RepoExtractExtractor } from "./repo-extract.extractor";

const execFile = promisify(execFileCb);

describe("RepoExtractExtractor", () => {
	let root: string;
	const svc = new RepoExtractExtractor();

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "cup-rextract-"));

		async function w(rel: string, content: string) {
			const abs = join(root, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
		}

		await w(
			"README.md",
			"# Sample Repo\n\nA test fixture for repo-extract.\n\n## Setup\nRun `npm install`.\n",
		);
		await w(
			"CHANGELOG.md",
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"- New thing.",
				"",
				"## [0.1.0] - 2025-12-01",
				"- Initial release.",
			].join("\n"),
		);
		await w(
			"package.json",
			JSON.stringify({
				name: "fixture",
				version: "0.0.1",
				description: "Test repo",
				scripts: { build: "tsc", test: "jest" },
			}),
		);
		await w(
			"src/main.ts",
			[
				"// TODO: rotate JWT keys before launch",
				"export function main() {",
				"  // FIXME: this branch should never run",
				'  return "hi";',
				"}",
			].join("\n"),
		);
		await w(
			"src/dirty/lots.ts",
			Array.from({ length: 5 }, (_, i) => `// TODO: cleanup ${i}`).join("\n"),
		);
		await w(
			"docs/state/issues.json",
			JSON.stringify({ open: ["a", "b", "c"] }),
		);
		// Ignored dirs:
		await w("node_modules/.bin/x", "// TODO: should never appear");
		await w(".git/HEAD", "ref: refs/heads/main");

		// Real git so lastCommitISO has something.
		await execFile("git", ["init", "-q", "--initial-branch=main"], {
			cwd: root,
		});
		await execFile("git", ["config", "user.email", "a@b.com"], { cwd: root });
		await execFile("git", ["config", "user.name", "A"], { cwd: root });
		await execFile("git", ["add", "."], { cwd: root });
		await execFile("git", ["commit", "-q", "-m", "init", "--no-gpg-sign"], {
			cwd: root,
		});
	}, 30_000);

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("extracts README title + excerpt", async () => {
		const ext = await svc.extract(root);
		expect(ext.readme?.title).toBe("Sample Repo");
		expect(ext.readme?.excerpt).toContain("A test fixture");
	});

	it("parses CHANGELOG entries by ## heading", async () => {
		const ext = await svc.extract(root);
		expect(ext.changelogEntries.length).toBe(2);
		expect(ext.changelogEntries[0].heading).toBe("[Unreleased]");
		expect(ext.changelogEntries[1].heading).toContain("0.1.0");
	});

	it("reads package.json metadata", async () => {
		const ext = await svc.extract(root);
		expect(ext.pkgMeta?.name).toBe("fixture");
		expect(ext.pkgMeta?.version).toBe("0.0.1");
		expect(ext.pkgMeta?.scripts).toContain("build");
	});

	it("scans TODO/FIXME markers and skips ignored dirs", async () => {
		const ext = await svc.extract(root);
		const files = ext.todos.map((t) => t.file).sort();
		// At least one TODO from src/main.ts and the 5 from src/dirty/lots.ts
		expect(files.filter((f) => f === "src/main.ts").length).toBeGreaterThan(0);
		expect(files.filter((f) => f === "src/dirty/lots.ts").length).toBe(5);
		// Nothing under node_modules or .git
		expect(files.find((f) => f.startsWith("node_modules/"))).toBeUndefined();
		expect(files.find((f) => f.startsWith(".git/"))).toBeUndefined();
	});

	it("captures FIXME marker distinctly from TODO", async () => {
		const ext = await svc.extract(root);
		const markers = new Set(ext.todos.map((t) => t.marker));
		expect(markers.has("TODO")).toBe(true);
		expect(markers.has("FIXME")).toBe(true);
	});

	it("ingests state files into stateEntries", async () => {
		const ext = await svc.extract(root);
		expect(ext.stateEntries.length).toBe(3);
		expect(ext.stateEntries[0].source).toBe("issues.json");
		expect(ext.stateEntries[0].bucket).toBe("open");
	});

	it("captures lastCommitISO from git", async () => {
		const ext = await svc.extract(root);
		expect(ext.lastCommitISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("returns empty extract for a non-repo directory", async () => {
		const empty = await mkdtemp(join(tmpdir(), "cup-empty-rext-"));
		try {
			const ext = await svc.extract(empty);
			expect(ext.readme).toBeNull();
			expect(ext.changelogEntries).toEqual([]);
			expect(ext.todos).toEqual([]);
			expect(ext.lastCommitISO).toBeNull();
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});

describe("parseChangelog", () => {
	it("returns one entry per ## heading", () => {
		const out = parseChangelog(
			"## [Unreleased]\n- a\n- b\n\n## [0.1.0]\n- initial\n",
		);
		expect(out.length).toBe(2);
		expect(out[0].heading).toBe("[Unreleased]");
		expect(out[0].body).toContain("- a");
		expect(out[1].heading).toBe("[0.1.0]");
	});

	it("ignores h1 and lower-level headings", () => {
		const out = parseChangelog("# Top\n## Real\n- x\n### Sub\n- y");
		expect(out.length).toBe(1);
		expect(out[0].heading).toBe("Real");
		expect(out[0].body).toContain("- x");
		expect(out[0].body).toContain("### Sub");
	});

	it("caps at 20 entries", () => {
		const sections = Array.from(
			{ length: 30 },
			(_, i) => `## v${i}\n- note ${i}\n`,
		).join("\n");
		expect(parseChangelog(sections).length).toBe(20);
	});
});
