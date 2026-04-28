// Pure plan generator: structured RepoExtract data in, per-repo task tree out.
// Kept separate from the worker because it's the contract between data
// extraction (the CLI / git hook) and ClickUp emission (the worker / direct
// service). Pure → trivially testable and reusable from dry-run mode.

import type {
	ChangelogEntry,
	ListKey,
	PlannedTask,
	RepoEntry,
	RepoExtract,
	RepoPlan,
	StateEntry,
	TodoMatch,
} from "./types";

export const LIST_NAMES: Record<ListKey, string> = {
	overview: "Overview & Docs",
	open_work: "Open Work",
	history: "History",
};

export const CUSTOM_FIELDS: { name: string; type: string }[] = [
	{ name: "Repo path", type: "short_text" },
	{ name: "Stack", type: "short_text" },
	{ name: "Deploy URL", type: "url" },
	{ name: "Port", type: "number" },
	{ name: "Last commit", type: "date" },
	{ name: "Source", type: "short_text" },
];

export const TASK_SOURCE = "clickup-tracker";

export function planRepo(repo: RepoEntry, ext: RepoExtract): RepoPlan {
	const tasks: PlannedTask[] = [];

	// Overview & Docs — always exactly one task per repo.
	tasks.push({
		key: "overview",
		list: "overview",
		name: `${repo.displayName} — overview`,
		markdown_description: buildOverviewDescription(repo, ext),
		custom_fields: {
			"Repo path": repo.path,
			Stack: repo.stack,
			"Last commit": ext.lastCommitISO
				? new Date(ext.lastCommitISO).getTime()
				: undefined,
			"Deploy URL": repo.deployUrl,
			Port: repo.port,
			Source: TASK_SOURCE,
		},
	});

	// Open Work — one task per TODO/FIXME match.
	for (const todo of ext.todos) {
		tasks.push({
			key: `todo:${todo.file}:${todo.line}`,
			list: "open_work",
			name: `${todo.marker}: ${truncate(todo.text, 80)}`,
			markdown_description: buildTodoDescription(repo, todo),
			custom_fields: { Source: TASK_SOURCE },
		});
	}
	if (ext.todosOverflow > 0) {
		tasks.push({
			key: "todo:overflow",
			list: "open_work",
			name: `+${ext.todosOverflow} more TODO/FIXME items not listed`,
			markdown_description:
				`${ext.todosOverflow} additional code-comment markers were truncated to keep the task volume manageable.` +
				` Run a fresh \`grep -rnE '\\b(TODO|FIXME|XXX|HACK):'\` in the repo to see them all.`,
			custom_fields: { Source: TASK_SOURCE },
		});
	}

	// Open Work — one task per pending *_STATE.json entry.
	for (const entry of ext.stateEntries) {
		tasks.push({
			key: `state:${entry.source}:${entry.bucket}:${entry.index}`,
			list: "open_work",
			name: `[${entry.bucket}] ${truncate(entry.preview, 80)}`,
			markdown_description: buildStateDescription(entry),
			custom_fields: { Source: TASK_SOURCE },
		});
	}

	// History — single task with last-N CHANGELOG entries as comments.
	if (ext.changelogEntries.length > 0) {
		tasks.push({
			key: "history",
			list: "history",
			name: `${repo.displayName} — recent changes`,
			markdown_description:
				`Last ${ext.changelogEntries.length} CHANGELOG entries.` +
				` See task comments for the actual content.`,
			comments: ext.changelogEntries.map(formatChangelogComment),
			custom_fields: { Source: TASK_SOURCE },
		});
	}

	return {
		repo,
		folderName: repo.displayName,
		lists: { ...LIST_NAMES },
		tasks,
	};
}

// ── description helpers ──────────────────────────────────────────

function buildOverviewDescription(repo: RepoEntry, ext: RepoExtract): string {
	const parts: string[] = [];
	if (ext.readme?.title) parts.push(`# ${ext.readme.title}`);
	if (ext.readme?.excerpt) parts.push(ext.readme.excerpt);

	const meta: string[] = [
		`**Path:** \`${repo.path}\``,
		`**Stack:** ${repo.stack}`,
	];
	if (repo.category) meta.push(`**Category:** ${repo.category}`);
	if (ext.lastCommitISO) meta.push(`**Last commit:** ${ext.lastCommitISO}`);
	if (repo.gitRemoteUrl) meta.push(`**Remote:** ${repo.gitRemoteUrl}`);
	if (repo.deployUrl) meta.push(`**Deploy:** ${repo.deployUrl}`);
	if (repo.port !== undefined) meta.push(`**Port:** ${repo.port}`);
	if (ext.pkgMeta?.name) meta.push(`**Package:** \`${ext.pkgMeta.name}\``);
	if (ext.pkgMeta?.version)
		meta.push(`**Version:** \`${ext.pkgMeta.version}\``);
	parts.push(meta.join("  \n"));

	if (ext.pkgMeta?.scripts && ext.pkgMeta.scripts.length > 0) {
		parts.push(
			`**Scripts:** ${ext.pkgMeta.scripts
				.slice(0, 12)
				.map((s) => `\`${s}\``)
				.join(", ")}`,
		);
	}

	return parts.filter(Boolean).join("\n\n");
}

function buildTodoDescription(repo: RepoEntry, todo: TodoMatch): string {
	return [
		`**File:** \`${todo.file}:${todo.line}\``,
		`**Marker:** \`${todo.marker}\``,
		"",
		"```",
		todo.text,
		"```",
		"",
		`_Found in repo \`${repo.name}\` by clickup-tracker._`,
	].join("\n");
}

function buildStateDescription(entry: StateEntry): string {
	let payload = "";
	try {
		payload =
			"```json\n" + JSON.stringify(entry.raw, null, 2).slice(0, 2000) + "\n```";
	} catch {
		payload = String(entry.raw).slice(0, 2000);
	}
	return [
		`**Source:** \`${entry.source}\``,
		`**Bucket:** \`${entry.bucket}\` (entry #${entry.index})`,
		"",
		payload,
	].join("\n");
}

function formatChangelogComment(e: ChangelogEntry): string {
	const body = e.body.trim().slice(0, 4000);
	return `## ${e.heading}\n\n${body || "_(no body)_"}`;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1) + "…";
}
