/**
 * Plan §H.1 — single source of truth for the visual prefix that goes on
 * every CU task name. Lets a non-technical viewer scan the List view and
 * understand commit type / severity / artifact kind without reading words.
 */

export type ConventionalType =
	| "feat"
	| "fix"
	| "chore"
	| "docs"
	| "refactor"
	| "test"
	| "perf"
	| "build"
	| "ci"
	| "revert"
	| "style"
	| string;

export type ArtifactKind =
	| "hotspot"
	| "module"
	| "deps"
	| "infra"
	| "release"
	| "deployment";

export type BugSeverity = "critical" | "high" | "medium" | "low";

const COMMIT_EMOJI: Record<string, string> = {
	feat: "✨",
	fix: "🐛",
	chore: "🔧",
	docs: "📝",
	refactor: "♻️",
	test: "🧪",
	perf: "⚡",
	build: "🏗️",
	ci: "🤖",
	revert: "⏪",
	style: "🎨",
};

const BUG_SEVERITY_EMOJI: Record<BugSeverity, string> = {
	critical: "🚨",
	high: "🟧",
	medium: "🟨",
	low: "🟢",
};

const ARTIFACT_EMOJI: Record<ArtifactKind, string> = {
	hotspot: "🔥",
	module: "📂",
	deps: "📦",
	infra: "🏗️",
	release: "🏷️",
	deployment: "🚀",
};

/** Returns the emoji for a conventional-commit type, or empty string. */
export function emojiForCommitType(type: ConventionalType | undefined): string {
	if (!type) return "";
	return COMMIT_EMOJI[type.toLowerCase()] ?? "";
}

/** Returns the emoji for a bug severity tag, or empty string. */
export function emojiForBugSeverity(
	severity: BugSeverity | string | undefined,
): string {
	if (!severity) return "";
	return BUG_SEVERITY_EMOJI[severity.toLowerCase() as BugSeverity] ?? "";
}

/** Returns the emoji for a synthetic artifact kind. */
export function emojiForArtifact(kind: ArtifactKind): string {
	return ARTIFACT_EMOJI[kind] ?? "";
}

/**
 * Compose a prefixed task name. If `emoji` is empty, the original `body`
 * is returned unchanged so existing tests/expectations stay readable.
 */
export function prefixName(emoji: string, body: string): string {
	if (!emoji) return body;
	return `${emoji} ${body}`;
}
