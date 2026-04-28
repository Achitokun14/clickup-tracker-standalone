import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Injectable, Logger } from "@nestjs/common";
import type {
	ChangelogEntry,
	PackageMeta,
	ReadmeSummary,
	RepoExtract,
	Stack,
	StateEntry,
	TodoMatch,
} from "../bulk/types";

const execFile = promisify(execFileCb);

const MAX_FILE_BYTES = 1_000_000; // 1 MB hard cap per file
const MAX_TODOS_TOTAL = 200; // beyond this we record todosOverflow
const MAX_TODO_LEN = 200;
const MAX_README_EXCERPT = 5_000;
const TODO_MARKER_RX = /\b(TODO|FIXME|XXX|HACK|BUG)\b\s*:?\s*(.+)$/;

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".turbo",
	".pnpm-store",
	".idea",
	".vscode",
	"coverage",
	".pytest_cache",
]);

const TODO_FILE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".rb",
	".php",
	".cs",
	".cpp",
	".c",
	".h",
	".hpp",
	".swift",
	".kt",
	".scala",
	".sh",
	".bash",
	".zsh",
	".sql",
	".vue",
	".svelte",
	".md",
]);

/**
 * Server-side equivalent of the client-side TODO/README/CHANGELOG extractor
 * that the install-git-hook.sh script and the legacy CLI used to compute.
 * Now the daemon owns canonical extraction so re-registration and replan
 * always produce a fresh picture regardless of which client kicked it off.
 *
 * Pure I/O on `localPath` — no network, no DB, no ClickUp calls.
 */
@Injectable()
export class RepoExtractExtractor {
	private readonly log = new Logger(RepoExtractExtractor.name);

	async extract(localPath: string): Promise<RepoExtract> {
		const root = resolve(localPath);
		const [
			readme,
			changelogEntries,
			todos,
			pkgMeta,
			stateEntries,
			lastCommitISO,
		] = await Promise.all([
			this.readReadme(root),
			this.readChangelog(root),
			this.scanTodos(root),
			this.readPackageMeta(root),
			this.readStateFiles(root),
			this.lastCommitIso(root),
		]);

		return {
			readme,
			changelogEntries,
			stateEntries,
			todos: todos.matches,
			todosOverflow: todos.overflow,
			lastCommitISO,
			pkgMeta,
		};
	}

	// ---------- README / CHANGELOG ----------

	private async readReadme(root: string): Promise<ReadmeSummary | null> {
		for (const name of [
			"README.md",
			"README.MD",
			"README.rst",
			"README.txt",
			"README",
		]) {
			const text = await this.readFileSafe(join(root, name));
			if (text === null) continue;
			const lines = text.split("\n");
			const titleLine = lines.find((l) => /^#\s+/.test(l));
			const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : null;
			const excerpt = text.slice(0, MAX_README_EXCERPT);
			return { title, excerpt };
		}
		return null;
	}

	private async readChangelog(root: string): Promise<ChangelogEntry[]> {
		for (const name of [
			"CHANGELOG.md",
			"CHANGELOG.MD",
			"HISTORY.md",
			"CHANGES.md",
		]) {
			const text = await this.readFileSafe(join(root, name));
			if (text === null) continue;
			return parseChangelog(text);
		}
		return [];
	}

	// ---------- TODOs ----------

	private async scanTodos(
		root: string,
	): Promise<{ matches: TodoMatch[]; overflow: number }> {
		const matches: TodoMatch[] = [];
		let overflow = 0;
		await this.walk(root, async (abs, rel) => {
			if (matches.length >= MAX_TODOS_TOTAL) {
				// Count subsequent files' total markers approximately by scanning anyway.
				// Simpler: just count the file's matches into overflow without storing.
				const text = await this.readFileSafe(abs);
				if (text === null) return;
				for (const _ of this.iterTodoMatches(text, rel)) overflow++;
				return;
			}
			const ext = extname(rel).toLowerCase();
			if (!TODO_FILE_EXTS.has(ext)) return;
			const text = await this.readFileSafe(abs);
			if (text === null) return;
			for (const m of this.iterTodoMatches(text, rel)) {
				if (matches.length < MAX_TODOS_TOTAL) matches.push(m);
				else overflow++;
			}
		});
		return { matches, overflow };
	}

	private *iterTodoMatches(text: string, file: string): Iterable<TodoMatch> {
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const m = TODO_MARKER_RX.exec(line);
			if (!m) continue;
			const marker = m[1];
			const rawText = m[2].trim().slice(0, MAX_TODO_LEN);
			yield { file, line: i + 1, marker, text: rawText };
		}
	}

	// ---------- package.json / pyproject / Cargo / go.mod ----------

	private async readPackageMeta(root: string): Promise<PackageMeta | null> {
		const pkg = await this.readJsonSafe(join(root, "package.json"));
		if (pkg) {
			return {
				name: typeof pkg.name === "string" ? pkg.name : undefined,
				version: typeof pkg.version === "string" ? pkg.version : undefined,
				description:
					typeof pkg.description === "string" ? pkg.description : undefined,
				scripts:
					pkg.scripts && typeof pkg.scripts === "object"
						? Object.keys(pkg.scripts as Record<string, unknown>).slice(0, 30)
						: undefined,
			};
		}
		// Other manifests: best-effort name+description, no scripts.
		for (const name of [
			"pyproject.toml",
			"Cargo.toml",
			"go.mod",
			"composer.json",
		]) {
			const text = await this.readFileSafe(join(root, name));
			if (text === null) continue;
			const nameMatch = /^name\s*=\s*["']?([^"'\n]+)["']?/m.exec(text);
			const versionMatch = /^version\s*=\s*["']?([^"'\n]+)["']?/m.exec(text);
			return {
				name: nameMatch?.[1]?.trim(),
				version: versionMatch?.[1]?.trim(),
			};
		}
		return null;
	}

	// ---------- state files ----------

	private async readStateFiles(root: string): Promise<StateEntry[]> {
		const entries: StateEntry[] = [];
		const dirs = ["docs/state", "state"];
		for (const d of dirs) {
			const abs = join(root, d);
			let listing: string[];
			try {
				listing = await fs.readdir(abs);
			} catch {
				continue;
			}
			for (const f of listing) {
				if (!f.endsWith(".json")) continue;
				const data = await this.readJsonSafe(join(abs, f));
				if (!data || typeof data !== "object") continue;
				for (const [bucket, items] of Object.entries(
					data as Record<string, unknown>,
				)) {
					if (!Array.isArray(items)) continue;
					items.slice(0, 50).forEach((raw, index) => {
						entries.push({
							source: f,
							bucket,
							index,
							preview:
								typeof raw === "string"
									? raw.slice(0, 120)
									: JSON.stringify(raw).slice(0, 120),
							raw,
						});
					});
				}
			}
		}
		return entries;
	}

	// ---------- last commit ----------

	private async lastCommitIso(root: string): Promise<string | null> {
		try {
			const { stdout } = await execFile("git", ["log", "-1", "--format=%cI"], {
				cwd: root,
			});
			return stdout.trim() || null;
		} catch {
			return null;
		}
	}

	// ---------- helpers ----------

	private async readFileSafe(abs: string): Promise<string | null> {
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
			return await fs.readFile(abs, "utf8");
		} catch {
			return null;
		}
	}

	private async readJsonSafe(
		abs: string,
	): Promise<Record<string, unknown> | null> {
		const text = await this.readFileSafe(abs);
		if (text === null) return null;
		try {
			const parsed = JSON.parse(text);
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}

	private async walk(
		root: string,
		onFile: (abs: string, rel: string) => Promise<void>,
	): Promise<void> {
		async function recurse(dir: string): Promise<void> {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					await recurse(abs);
				} else if (entry.isFile()) {
					const rel = relative(root, abs).split(sep).join("/");
					await onFile(abs, rel);
				}
			}
		}
		await recurse(root);
	}
}

// ---------- pure helpers ----------

export function parseChangelog(text: string): ChangelogEntry[] {
	const lines = text.split("\n");
	const entries: ChangelogEntry[] = [];
	let currentHeading: string | null = null;
	let currentBody: string[] = [];
	for (const line of lines) {
		const headingMatch = /^##\s+(.+)$/.exec(line);
		if (headingMatch) {
			if (currentHeading !== null) {
				entries.push({
					heading: currentHeading,
					body: currentBody.join("\n").trim(),
				});
			}
			currentHeading = headingMatch[1].trim();
			currentBody = [];
		} else if (currentHeading !== null) {
			currentBody.push(line);
		}
	}
	if (currentHeading !== null) {
		entries.push({
			heading: currentHeading,
			body: currentBody.join("\n").trim(),
		});
	}
	return entries.slice(0, 20); // cap at 20 most-recent entries
}

export function detectStack(
	pkgMeta: PackageMeta | null,
	files: string[],
): Stack {
	if (pkgMeta?.name) {
		if (pkgMeta.scripts?.some((s) => /tsc|typescript/i.test(s))) return "TS";
		return "Node";
	}
	if (files.some((f) => f === "go.mod")) return "Go";
	if (files.some((f) => f === "Cargo.toml")) return "Rust";
	if (files.some((f) => f === "pyproject.toml" || f === "requirements.txt"))
		return "Python";
	if (files.some((f) => f === "composer.json")) return "PHP";
	return "Unknown";
}
