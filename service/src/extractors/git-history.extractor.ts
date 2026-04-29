import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Logger } from "@nestjs/common";
import { compareIsoWeekKeys, isoWeekOf } from "../util/iso-week";
import { parseGitRemote, type ParsedGitRemote } from "../util/git-remote-parse";
import { classifyType, type ConventionalType } from "../util/classify";
import { parseConventional } from "../events/conventional";

const execFile = promisify(execFileCb);

const MAX_BACKFILL_COMMITS = (() => {
	const n = parseInt(process.env.MAX_BACKFILL_COMMITS || "5000", 10);
	return Number.isFinite(n) && n > 0 ? n : 5000;
})();

const GIT_LOG_FORMAT = [
	"%H", // commit sha
	"%P", // parent shas (space-separated)
	"%an", // author name
	"%ae", // author email
	"%aI", // author date ISO 8601 strict
	"%cn", // committer name
	"%ce", // committer email
	"%cI", // committer date ISO 8601 strict
	"%D", // refs (decoration)
	"%s", // subject
	"%b", // body
].join("%x09");
const COMMIT_SEP = "\x1e"; // ASCII RS — record separator. Placed at the START
// of each commit's format so split() keeps each commit's header+numstat together.

export interface CommitFileChange {
	path: string;
	additions: number;
	deletions: number;
	status: "A" | "M" | "D" | "R";
}

export interface CommitRecord {
	sha: string;
	parents: string[];
	author: { name: string; email: string; date: string };
	committer: { name: string; email: string; date: string };
	refs: string[];
	branch: string | null;
	subject: string;
	body: string;
	type: ConventionalType;
	scope: string | null;
	filesChanged: CommitFileChange[];
	isMergeCommit: boolean;
	sprintKey: string;
	sprintOrdinal: number;
	sprintRange: { startDate: string; endDate: string };
}

export interface SprintBucket {
	key: string;
	ordinal: number;
	startDate: string;
	endDate: string;
	commitCount: number;
}

export interface GitHistoryExtract {
	commits: CommitRecord[]; // chronological asc
	sprints: SprintBucket[];
	remote: { url: string | null; host: string | null; ownerRepo: string | null };
	defaultBranch: string;
	truncated: boolean;
}

/**
 * Read the full git history of a local repo and bucket commits into ISO-week
 * sprints. Pure I/O + parsing — no ClickUp calls. Caps at
 * MAX_BACKFILL_COMMITS (default 5000); when exceeded, returns the
 * newest-first window and sets `truncated: true`.
 *
 * Shells out to `git` via execFile (never `exec`) — argument-injection safe.
 */
@Injectable()
export class GitHistoryExtractor {
	private readonly log = new Logger(GitHistoryExtractor.name);

	async extract(localPath: string): Promise<GitHistoryExtract> {
		const remoteUrl = await this.getRemoteUrl(localPath);
		const parsed = remoteUrl ? parseGitRemote(remoteUrl) : null;
		const defaultBranch = await this.getDefaultBranch(localPath);

		const commits = await this.parseCommits(localPath);
		const truncated = commits.length >= MAX_BACKFILL_COMMITS;

		// Chronological asc.
		commits.sort((a, b) => a.author.date.localeCompare(b.author.date));

		// Bucket into ISO weeks and assign ordinals globally.
		const bucketMap = new Map<string, SprintBucket>();
		for (const c of commits) {
			const w = isoWeekOf(new Date(c.author.date));
			c.sprintKey = w.key;
			c.sprintRange = { startDate: w.startDate, endDate: w.endDate };
			const existing = bucketMap.get(w.key);
			if (existing) {
				existing.commitCount += 1;
			} else {
				bucketMap.set(w.key, {
					key: w.key,
					ordinal: 0, // assigned below
					startDate: w.startDate,
					endDate: w.endDate,
					commitCount: 1,
				});
			}
		}
		const sprints = [...bucketMap.values()].sort((a, b) =>
			compareIsoWeekKeys(a.key, b.key),
		);
		sprints.forEach((s, i) => {
			s.ordinal = i + 1;
		});
		const ordinalByKey = new Map(sprints.map((s) => [s.key, s.ordinal]));
		for (const c of commits) {
			c.sprintOrdinal = ordinalByKey.get(c.sprintKey) ?? 0;
		}

		return {
			commits,
			sprints,
			remote: {
				url: remoteUrl,
				host: parsed?.host ?? null,
				ownerRepo: parsed?.ownerRepo ?? null,
			},
			defaultBranch,
			truncated,
		};
	}

	// ---------- internals ----------

	private async getRemoteUrl(cwd: string): Promise<string | null> {
		try {
			const { stdout } = await execFile(
				"git",
				["remote", "get-url", "origin"],
				{ cwd },
			);
			return stdout.trim() || null;
		} catch {
			return null;
		}
	}

	private async getDefaultBranch(cwd: string): Promise<string> {
		// Preferred: ask the remote what HEAD points to.
		try {
			const { stdout } = await execFile(
				"git",
				["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
				{ cwd },
			);
			const ref = stdout.trim().replace(/^origin\//, "");
			if (ref) return ref;
		} catch {
			/* fall through */
		}
		// Fallback chain: main → master → first remote-tracking branch by recency.
		for (const candidate of ["main", "master"]) {
			try {
				await execFile(
					"git",
					["rev-parse", "--verify", `refs/remotes/origin/${candidate}`],
					{ cwd },
				);
				return candidate;
			} catch {
				/* try next */
			}
		}
		try {
			const { stdout } = await execFile(
				"git",
				["branch", "-r", "--sort=-committerdate"],
				{ cwd },
			);
			const first = stdout
				.split("\n")
				.map((l) => l.trim())
				.find(Boolean);
			if (first) return first.replace(/^origin\//, "");
		} catch {
			/* give up */
		}
		return "main";
	}

	private async parseCommits(cwd: string): Promise<CommitRecord[]> {
		let stdout: string;
		try {
			const r = await execFile(
				"git",
				[
					"log",
					"--all",
					"--no-merges",
					`--max-count=${MAX_BACKFILL_COMMITS}`,
					`--pretty=format:${COMMIT_SEP}${GIT_LOG_FORMAT}`,
					"--numstat",
				],
				{ cwd, maxBuffer: 1024 * 1024 * 64 },
			);
			stdout = r.stdout;
		} catch (err) {
			// Empty repo or non-repo path → return zero commits cleanly.
			this.log.debug(`git log failed in ${cwd}: ${(err as Error).message}`);
			return [];
		}

		if (!stdout.trim()) return [];

		const records = stdout
			.split(COMMIT_SEP)
			.map((r) => r.trim())
			.filter(Boolean);
		const commits: CommitRecord[] = [];
		for (const block of records) {
			const parsed = this.parseOneCommit(block);
			if (parsed) commits.push(parsed);
		}
		return commits;
	}

	private parseOneCommit(block: string): CommitRecord | null {
		// First line is the header (TAB-separated fields). Rest is numstat.
		const newlineIdx = block.indexOf("\n");
		const headerLine = newlineIdx >= 0 ? block.slice(0, newlineIdx) : block;
		const rest = newlineIdx >= 0 ? block.slice(newlineIdx + 1) : "";

		const fields = headerLine.split("\t");
		if (fields.length < 11) return null;
		const [
			sha,
			parentsStr,
			an,
			ae,
			aI,
			cn,
			ce,
			cI,
			decoration,
			subject,
			...bodyChunks
		] = fields;
		// %b can contain tabs — rejoin everything past the 10th field.
		const body = bodyChunks.join("\t");

		const refs = decoration
			? decoration
					.split(",")
					.map((r) => r.trim())
					.map((r) => r.replace(/^HEAD ->\s*/, ""))
					.filter(Boolean)
			: [];

		const filesChanged = parseNumstat(rest);

		const cc = parseConventional(`${subject}\n${body}`);
		const ccType = cc.type ?? null;
		const subj = (subject ?? "").trim();
		const type = mapCcTypeToBgmt(ccType) ?? classifyType(subj, body);
		const scope = cc.scope ?? null;

		const parents = parentsStr ? parentsStr.split(/\s+/).filter(Boolean) : [];
		const isMergeCommit = parents.length > 1;

		return {
			sha,
			parents,
			author: { name: an, email: ae, date: aI },
			committer: { name: cn, email: ce, date: cI },
			refs,
			branch: pickBranch(refs),
			subject: subj,
			body: body.trim(),
			type,
			scope,
			filesChanged,
			isMergeCommit,
			sprintKey: "", // filled by extract()
			sprintOrdinal: 0,
			sprintRange: { startDate: "", endDate: "" },
		};
	}
}

// ---------- pure helpers ----------

function parseNumstat(text: string): CommitFileChange[] {
	const out: CommitFileChange[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
		const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
		const path = parts[2];
		// Rename detection: `--numstat` emits "old\tnew" or "{old => new}" forms.
		// For simplicity we collapse to the destination path with status R.
		let status: CommitFileChange["status"] = "M";
		let finalPath = path;
		if (parts.length > 3) {
			// Format: "0\t0\told_path\tnew_path"
			finalPath = parts[3];
			status = "R";
		} else if (/^\{.+ => .+\}/.test(path) || / => /.test(path)) {
			status = "R";
		}
		out.push({ path: finalPath, additions, deletions, status });
	}
	return out;
}

function pickBranch(refs: string[]): string | null {
	for (const r of refs) {
		if (r.startsWith("refs/heads/")) return r.replace("refs/heads/", "");
		if (r.startsWith("origin/")) return r.replace("origin/", "");
	}
	// Decoration usually omits the refs/* prefix; fall back to first non-tag ref.
	for (const r of refs) {
		if (r.startsWith("tag:")) continue;
		if (r.startsWith("HEAD")) continue;
		return r;
	}
	return null;
}

function mapCcTypeToBgmt(cc: string | null): ConventionalType | null {
	if (!cc) return null;
	switch (cc.toLowerCase()) {
		case "feat":
			return "Feature";
		case "fix":
			return "Bug Fix";
		case "docs":
			return "Docs";
		case "refactor":
		case "restructure":
			return "Refactor";
		case "chore":
			return "Chore";
		case "style":
			return "Style";
		case "perf":
			return "Performance";
		case "test":
			return "Test";
		case "build":
			return "Build";
		case "ci":
			return "CI/CD";
		case "revert":
			return "Revert";
		default:
			return null;
	}
}
