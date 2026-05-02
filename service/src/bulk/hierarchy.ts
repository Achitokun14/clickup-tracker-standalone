// Pure plan generator: structured RepoExtract data in, per-repo task tree out.
// Kept separate from the worker because it's the contract between data
// extraction (the CLI / git hook) and ClickUp emission (the worker / direct
// service). Pure → trivially testable and reusable from dry-run mode.

import type {
	CommitRecord,
	GitHistoryExtract,
} from "../extractors/git-history.extractor";
import {
	assignPriority,
	classifyEpic,
	deriveTags,
	estimateMinutes,
	normalizeAuthor,
	priorityToCu,
} from "../util/classify";
import { commitUrl } from "../util/commit-url";
import {
	emojiForArtifact,
	emojiForBugSeverity,
	emojiForCommitType,
	prefixName,
} from "../util/emoji-map";
import type { ParsedGitRemote } from "../util/git-remote-parse";
import type {
	ChangelogEntry,
	DocPagePlan,
	ListKey,
	PlannedSpaceTask,
	PlannedTask,
	RepoEntry,
	RepoExtract,
	RepoPlan,
	SpaceFolderPlan,
	SpacePlan,
	StateEntry,
	StatusDef,
	TodoMatch,
	ViewDef,
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
		markdown_content: buildOverviewDescription(repo, ext),
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
			markdown_content: buildTodoDescription(repo, todo),
			custom_fields: { Source: TASK_SOURCE },
		});
	}
	if (ext.todosOverflow > 0) {
		tasks.push({
			key: "todo:overflow",
			list: "open_work",
			name: `+${ext.todosOverflow} more TODO/FIXME items not listed`,
			markdown_content:
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
			markdown_content: buildStateDescription(entry),
			custom_fields: { Source: TASK_SOURCE },
		});
	}

	// History — single task with last-N CHANGELOG entries as comments.
	if (ext.changelogEntries.length > 0) {
		tasks.push({
			key: "history",
			list: "history",
			name: `${repo.displayName} — recent changes`,
			markdown_content:
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

// ────────────────────────────────────────────────────────────────────
// Session 3 — per-repo Space planner.
//
// Pure: takes the (already-server-extracted) RepoExtract + GitHistoryExtract
// and returns a SpacePlan. The orchestrator in Session 4 walks the plan and
// turns it into ClickUpDirectService calls. No I/O, no ClickUp ids resolved
// here — listKey is the symbolic handle.
// ────────────────────────────────────────────────────────────────────

/** 7-status cascade applied at Space level (plan §2). */
export const SPACE_STATUSES: StatusDef[] = [
	{ status: "Backlog", type: "open", color: "#87909e", orderindex: 0 },
	{ status: "To Do", type: "open", color: "#3397dd", orderindex: 1 },
	{ status: "In Progress", type: "custom", color: "#ffb84d", orderindex: 2 },
	{ status: "In Review", type: "custom", color: "#a875ff", orderindex: 3 },
	{ status: "Blocked", type: "custom", color: "#e50000", orderindex: 4 },
	{ status: "Done", type: "done", color: "#2ecd6f", orderindex: 5 },
	{ status: "Archived", type: "closed", color: "#6f7782", orderindex: 6 },
];

/**
 * Map a 7-status / 6-status name to ClickUp's default 2-status set
 * ("to do" | "complete"). ClickUp v2 silently ignores `statuses` on both
 * createSpace and PUT /space — so newly-created Spaces always start with
 * the default set. Until the user runs the manual UI walkthrough to
 * upgrade the workspace, lifecycle/backfill must emit names that exist.
 *
 * Mapping rules:
 *   - any "done" or "closed" type     → "complete"
 *   - everything else                 → "to do"
 */
export function mapInlineStatus(name: string): "to do" | "complete" {
	const lower = name.toLowerCase();
	if (
		lower === "done" ||
		lower === "archived" ||
		lower === "closed" ||
		lower === "won't fix" ||
		lower === "wont fix" ||
		lower === "complete"
	) {
		return "complete";
	}
	return "to do";
}

/** 6-status override applied to the Bugs List only. */
export const BUG_STATUSES: StatusDef[] = [
	{ status: "Reported", type: "open", color: "#e50000", orderindex: 0 },
	{ status: "Triaged", type: "custom", color: "#ffb84d", orderindex: 1 },
	{ status: "Fixing", type: "custom", color: "#3397dd", orderindex: 2 },
	{ status: "Verifying", type: "custom", color: "#a875ff", orderindex: 3 },
	{ status: "Closed", type: "done", color: "#2ecd6f", orderindex: 4 },
	{ status: "Won't Fix", type: "closed", color: "#6f7782", orderindex: 5 },
];

/** Static folder/list scaffold (sprint Lists are appended dynamically). */
export const SPACE_FOLDERS: SpaceFolderPlan[] = [
	{
		name: "📦 Backlog & Bugs",
		emoji: "📦",
		lists: [
			{ key: "open_work", name: "Open Work" },
			{ key: "bugs", name: "Bugs", statusOverrides: BUG_STATUSES },
		],
	},
	{
		name: "🚧 Active Work",
		emoji: "🚧",
		lists: [
			{ key: "active_sprint", name: "Active Sprint" },
			{ key: "in_review", name: "In Review" },
		],
	},
	{
		name: "📜 History",
		emoji: "📜",
		lists: [], // filled per-sprint in planSpace()
	},
	{
		name: "📚 Knowledge",
		emoji: "📚",
		lists: [
			{ key: "adrs", name: "ADRs" },
			{ key: "agent_sessions", name: "Agent Sessions" },
		],
	},
];

/** ClickUp Space features required by the plan. Booleans only — the API
 * accepts the wider feature object; planner emits the minimal toggle set. */
export const SPACE_FEATURES: Record<string, unknown> = {
	due_dates: { enabled: true, start_date: true, remap_due_dates: true },
	time_tracking: { enabled: true },
	tags: { enabled: true },
	time_estimates: { enabled: true },
	checklists: { enabled: true },
	custom_fields: { enabled: true },
	dependency_warning: { enabled: true },
	sprints: { enabled: true },
	points: { enabled: true },
	milestones: { enabled: true },
};

/** Tags pre-created on the Space before any tasks land. Static set; per-Type/
 * per-Source/per-Epic tags are added dynamically below. */
export const STATIC_TAGS = [
	"frontend",
	"backend",
	"infra",
	"database",
	"security",
	"ai",
	"i18n",
	"api",
	"docs",
	"testing",
	"general",
	"adr",
	"bug",
];

const STATIC_SOURCE_TAGS = [
	"source:human",
	"source:claude-code",
	"source:goose",
	"source:opencode",
	"source:cursor",
	"source:cline",
	"source:continue",
];

const STATIC_TYPE_TAGS = [
	"type:feature",
	"type:bug-fix",
	"type:refactor",
	"type:docs",
	"type:chore",
	"type:style",
	"type:performance",
	"type:test",
	"type:build",
	"type:ci-cd",
	"type:revert",
];

export interface PlanSpaceOptions {
	/** Provided when the calling project has a per-project author email map. */
	authorMap?: Record<string, string>;
	/** Default source tag when no header is present (typically "human"). */
	defaultSource?: string;
	/** Cap top-N file subtasks per commit. */
	maxSubtasksPerCommit?: number;
	/** Threshold above which a commit gets file-level subtasks. */
	subtaskFileThreshold?: number;
	/** Truncation marker text (callers may localise). */
	truncationMessage?: string;
}

export function planSpace(
	repo: RepoEntry,
	extract: RepoExtract,
	history: GitHistoryExtract,
	options: PlanSpaceOptions = {},
): SpacePlan {
	const defaultSource = options.defaultSource ?? "human";
	const maxSubtasksPerCommit = options.maxSubtasksPerCommit ?? 10;
	const subtaskFileThreshold = options.subtaskFileThreshold ?? 3;

	// Folders: clone the static scaffold and append one List per ISO sprint.
	const folders: SpaceFolderPlan[] = SPACE_FOLDERS.map((f) => ({
		...f,
		lists: f.lists.map((l) => ({ ...l })),
	}));
	const historyFolder = folders.find((f) => f.name === "📜 History");
	if (!historyFolder) throw new Error("history folder missing from scaffold");
	for (const s of history.sprints) {
		historyFolder.lists.push({
			key: sprintListKey(s.key),
			name: `Sprint ${s.ordinal} — ${s.startDate} → ${s.endDate}`,
		});
	}

	// Tasks + per-task tag set.
	const tasks: PlannedSpaceTask[] = [];
	const dynamicTags = new Set<string>();
	const remote: ParsedGitRemote | null =
		history.remote.host && history.remote.ownerRepo
			? { host: history.remote.host, ownerRepo: history.remote.ownerRepo }
			: null;

	// 1. Truncation warning task (Open Work).
	if (history.truncated) {
		tasks.push({
			key: "warn:history-truncated",
			listKey: "open_work",
			name:
				options.truncationMessage ??
				`⚠️ History truncated at ${history.commits.length} commits — older history not imported`,
			markdown_content:
				"Backfill capped by `MAX_BACKFILL_COMMITS` (env-tunable, default 5000)." +
				" Older commits are NOT represented in the History folder. Increase the cap" +
				" and `POST /projects/:id/replan` to import the rest.",
			status: "Backlog",
			priority: priorityToCu("Normal"),
			tags: ["docs", `source:${kebab(defaultSource)}`],
		});
	}

	// 2. ADR tasks (Knowledge → ADRs). Detect by file path heuristic across
	// commits: any commit whose changed files include adr/decisions/architecture.
	for (const adr of detectAdrs(history.commits)) {
		const tagSet = new Set([
			"adr",
			"docs",
			`source:${kebab(defaultSource)}`,
			`type:docs`,
		]);
		tasks.push({
			key: `adr:${adr.slug}`,
			listKey: "adrs",
			// Plan §H.1 — ADRs surface in the Knowledge folder with the docs emoji.
			name: prefixName(emojiForCommitType("docs"), `ADR — ${adr.title}`),
			markdown_content: adr.markdown,
			status: "Done",
			priority: priorityToCu("Normal"),
			tags: [...tagSet].sort(),
			startDateMs: adr.firstSeenMs,
			dueDateMs: adr.lastSeenMs,
		});
		for (const t of tagSet) dynamicTags.add(t);
	}

	// 3. Open Work tasks from extract.todos.
	for (const todo of extract.todos) {
		const isBug = /\b(BUG|FIXME|XXX|HACK)\b/i.test(todo.marker);
		const tagSet = new Set([
			isBug ? "bug" : "general",
			`type:${isBug ? "bug-fix" : "chore"}`,
			`source:${kebab(defaultSource)}`,
		]);
		// Plan §H.1 — bug tasks surface with severity emoji (extracted later
		// from priority); TODO/FIXME items use the chore wrench.
		const todoEmoji = isBug
			? emojiForBugSeverity("high")
			: emojiForCommitType("chore");
		tasks.push({
			key: `${isBug ? "bug" : "todo"}:${todo.file}:${todo.line}`,
			listKey: isBug ? "bugs" : "open_work",
			name: prefixName(todoEmoji, `${todo.marker}: ${truncate(todo.text, 80)}`),
			markdown_content: buildTodoDescription(repo, todo),
			status: isBug ? "Reported" : "Backlog",
			priority: priorityToCu(isBug ? "High" : "Low"),
			tags: [...tagSet].sort(),
		});
		for (const t of tagSet) dynamicTags.add(t);
	}
	if (extract.todosOverflow > 0) {
		tasks.push({
			key: "todo:overflow",
			listKey: "open_work",
			name: `+${extract.todosOverflow} more TODO/FIXME items not listed`,
			markdown_content:
				`${extract.todosOverflow} additional code-comment markers were truncated to keep the task volume manageable.` +
				" Run a fresh `grep -rnE '\\b(TODO|FIXME|XXX|HACK):'` in the repo to see them all.",
			status: "Backlog",
			priority: priorityToCu("Low"),
			tags: ["docs", `source:${kebab(defaultSource)}`, "type:chore"].sort(),
		});
	}

	// 4. Commit tasks — one per commit, in its ISO-week sprint List.
	for (const commit of history.commits) {
		const planned = planCommitTask(
			commit,
			history.defaultBranch,
			remote,
			defaultSource,
			options.authorMap,
		);
		tasks.push(planned);
		for (const t of planned.tags) dynamicTags.add(t);

		// File-level subtasks for high-impact commits. Capped at top-N by churn.
		if (commit.filesChanged.length > subtaskFileThreshold) {
			const top = [...commit.filesChanged]
				.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
				.slice(0, maxSubtasksPerCommit);
			for (const f of top) {
				tasks.push({
					key: `commit:${commit.sha}:file:${f.path}`,
					listKey: planned.listKey,
					name: `${f.status} ${f.path}`,
					markdown_content: [
						`Part of commit \`${shortSha(commit.sha)}\`.`,
						`+${f.additions} / -${f.deletions} lines.`,
					].join("\n\n"),
					status: planned.status,
					priority: planned.priority,
					tags: planned.tags,
					startDateMs: planned.startDateMs,
					dueDateMs: planned.dueDateMs,
					parentKey: planned.key,
				});
			}
		}
	}

	// 5. Doc — five static pages, content seeded from extract where available.
	const docPages: DocPagePlan[] = [
		{
			name: "Overview",
			markdown: buildDocOverview(repo, extract, history),
		},
		{
			name: "Setup",
			markdown:
				extractReadmeSection(extract.readme?.excerpt, "Setup") ??
				"_Setup section not found in README — fill me in._",
		},
		{
			name: "Conventions",
			markdown: "_CONTRIBUTING.md / CODE_OF_CONDUCT.md not yet imported._",
		},
		{
			name: "Changelog",
			markdown: extract.changelogEntries.length
				? extract.changelogEntries
						.map((e) => `## ${e.heading}\n\n${e.body || "_(no body)_"}`)
						.join("\n\n---\n\n")
				: "_No CHANGELOG.md found in the repo._",
		},
		{
			name: "Agent Prompt Log",
			markdown:
				"_Auto-populated by the daemon as agent sessions land. Most recent 50 sessions._",
		},
		// Plan §G.3 — auto-managed Handbook pages.
		{
			name: "Contributors",
			markdown:
				"_Auto-populated by the daemon. Refreshed on each commit + nightly via the contributors cron._\n\n" +
				"| Contributor | Commits | First seen | Last seen |\n" +
				"|---|---|---|---|\n" +
				"| _waiting for first commit_ | – | – | – |",
		},
		{
			name: "Architecture",
			markdown:
				"_Auto-populated by the daemon as new top-level directories appear in commits._\n\n" +
				"_No directories detected yet._",
		},
		{
			name: "Dashboard",
			markdown:
				"_Auto-populated by the daemon. Re-renders after Lists + views are seeded._\n\n" +
				"_Waiting for first backfill._",
		},
		// Plan §I.5 — Ownership map auto-managed by the groomer daily refresh.
		{
			name: "Ownership",
			markdown:
				"_Auto-managed by clickup-tracker — refreshed nightly. " +
				"Top-3 owners per file ranked by recency-weighted line deltas._\n\n" +
				"_Waiting for first commit._",
		},
		// Plan §L.3 — Risk Register auto-populated from per-file risk scores.
		{
			name: "Risk Register",
			markdown:
				"_Auto-managed by clickup-tracker — refreshed nightly. " +
				"Per-file risk = log1p(churn) × 0.4 + bugs × 1.5 + LOC/1000 × 0.2 + test_age/90 × 0.3._\n\n" +
				"_Waiting for first commit._",
		},
	];

	// 6. Default views per List.
	const views: ViewDef[] = buildDefaultViews(folders);

	// 7. Combine static + dynamic tag sets.
	const allTags = new Set<string>([
		...STATIC_TAGS,
		...STATIC_TYPE_TAGS,
		...STATIC_SOURCE_TAGS,
		...dynamicTags,
	]);

	return {
		spaceName: repo.displayName,
		multipleAssignees: true,
		features: SPACE_FEATURES,
		statuses: SPACE_STATUSES,
		bugStatuses: BUG_STATUSES,
		folders,
		tags: [...allTags].sort(),
		doc: { name: `${repo.displayName} Handbook`, pages: docPages },
		views,
		tasks,
		templateStatus: "inline-fallback",
	};
}

// ── planSpace helpers ───────────────────────────────────────────

export function sprintListKey(isoWeekKey: string): string {
	return `sprint:${isoWeekKey}`;
}

/**
 * Public single-commit planner. Used by the lifecycle handler in
 * events.service to construct a PlannedSpaceTask for a brand-new commit
 * landing via the post-commit webhook — guarantees backfill and live
 * lifecycle produce identical task shapes.
 */
export function planSpaceCommitTask(
	commit: CommitRecord,
	defaultBranch: string,
	remote: ParsedGitRemote | null,
	defaultSource = "human",
	authorMap?: Record<string, string>,
): PlannedSpaceTask {
	return planCommitTask(
		commit,
		defaultBranch,
		remote,
		defaultSource,
		authorMap,
	);
}

function planCommitTask(
	commit: CommitRecord,
	defaultBranch: string,
	remote: ParsedGitRemote | null,
	defaultSource: string,
	authorMap?: Record<string, string>,
): PlannedSpaceTask {
	const onDefault =
		commit.branch === defaultBranch ||
		commit.refs.some(
			(r) => r === defaultBranch || r === `origin/${defaultBranch}`,
		) ||
		// Defence in depth: if neither branch nor refs reached us, treat as
		// default. A post-commit hook on a developer's local repo without
		// branch info is overwhelmingly on the local default branch; routing
		// such commits to in_review buries them. Layered with hook-script +
		// daemon-side synth so this branch should rarely fire in practice.
		(commit.branch == null && commit.refs.length === 0);
	const status = onDefault ? "Done" : "In Review";
	const listKey = onDefault ? sprintListKey(commit.sprintKey) : "in_review";

	const subj = commit.subject || "(no subject)";
	const dateYmd = (commit.author.date || "").slice(0, 10);
	const scope = commit.scope ? `(${commit.scope})` : "";
	// Strip the conventional-commit prefix from the subject so we don't double it
	// in the task name (`[date] Feature(api): feat(api): foo` → `: foo`).
	const cleanSubj = stripConventionalPrefix(subj);
	// Plan §H.1 — emoji prefix per conventional-commit type.
	const emoji = emojiForCommitType(commit.type);
	const baseName = `[${dateYmd}] ${commit.type}${scope}: ${truncate(cleanSubj, 80)}`;
	const name = prefixName(emoji, baseName);

	const epic = classifyEpic(subj, commit.body);
	const files = commit.filesChanged.map((f) => f.path);
	const tags = deriveTags({
		subject: subj,
		body: commit.body,
		files,
		type: commit.type,
		source: defaultSource,
		epic,
	});
	tags.push(`epic:${kebab(epic)}`);

	const additions = commit.filesChanged.reduce((a, f) => a + f.additions, 0);
	const deletions = commit.filesChanged.reduce((a, f) => a + f.deletions, 0);
	const points = Math.max(1, Math.ceil((additions + deletions) / 100));
	const minutes = estimateMinutes(
		commit.filesChanged.length,
		additions + deletions,
		commit.type,
	);
	const priority = priorityToCu(assignPriority(commit.type, subj, commit.body));

	const author = normalizeAuthor(commit.author.email, authorMap);
	const url = commitUrl(remote, commit.sha);

	return {
		key: `commit:${commit.sha}`,
		listKey,
		name,
		markdown_content: buildCommitDescription(commit, {
			authorDisplay: author || commit.author.name,
			commitUrl: url,
			additions,
			deletions,
			epic,
		}),
		status,
		priority,
		tags: [...new Set(tags)].sort(),
		startDateMs: msFromIso(commit.author.date),
		dueDateMs: msFromIso(commit.committer.date),
		points,
		timeEstimateMs: minutes * 60_000,
		assigneeEmails: author ? [author] : [],
	};
}

interface CommitDescriptionCtx {
	authorDisplay: string;
	commitUrl: string | null;
	additions: number;
	deletions: number;
	epic: string;
}

function buildCommitDescription(
	c: CommitRecord,
	ctx: CommitDescriptionCtx,
): string {
	const shaCell = ctx.commitUrl
		? `[\`${shortSha(c.sha)}\`](${ctx.commitUrl})`
		: `\`${shortSha(c.sha)}\``;
	const topFiles = [...c.filesChanged]
		.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
		.map(
			(f) => `- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`,
		)
		.join("\n");
	const bodyRaw = c.body.trim();

	// Plan §H.2 — collapsible Files Changed + Body sections so the task
	// description stays scannable. Header line is a single quote with the
	// commit summary; details live behind <details> for noise control.
	const lines: string[] = [];
	lines.push(`**${c.type}${c.scope ? `(${c.scope})` : ""}: ${c.subject}**`);
	lines.push("");
	lines.push(
		`> commit ${shaCell} · author ${ctx.authorDisplay} · branch \`${c.branch ?? "(detached)"}\` · ${c.author.date}`,
	);
	lines.push("");
	lines.push(
		`**Impact:** ${c.filesChanged.length} files changed, +${ctx.additions}/-${ctx.deletions}`,
	);
	lines.push("");
	lines.push(
		`<details><summary>Files changed (${c.filesChanged.length})</summary>`,
	);
	lines.push("");
	lines.push(topFiles || "_(no file changes recorded)_");
	lines.push("");
	lines.push("</details>");
	lines.push("");
	if (bodyRaw) {
		lines.push("<details><summary>Commit body</summary>");
		lines.push("");
		lines.push(bodyRaw);
		lines.push("");
		lines.push("</details>");
		lines.push("");
	}
	lines.push("---");
	lines.push(
		`_Auto-imported by clickup-tracker. Type: ${c.type} · Epic: ${ctx.epic} · Sprint: ${c.sprintKey}_`,
	);
	return lines.join("\n");
}

interface AdrEntry {
	slug: string;
	title: string;
	markdown: string;
	firstSeenMs: number;
	lastSeenMs: number;
}

const ADR_PATH_RX = /(?:^|\/)(?:adr|decisions|architecture)\/.+\.mdx?$/i;
const ADR_TOPLEVEL_RX = /^(?:ARCHITECTURE|ADR-[\w-]+)\.mdx?$/i;

function detectAdrs(commits: CommitRecord[]): AdrEntry[] {
	const seen = new Map<string, AdrEntry>();
	for (const c of commits) {
		for (const f of c.filesChanged) {
			if (!ADR_PATH_RX.test(f.path) && !ADR_TOPLEVEL_RX.test(f.path)) continue;
			const slug = kebab(f.path.replace(/\.[^.]+$/, ""));
			const ms = msFromIso(c.author.date) ?? 0;
			const existing = seen.get(slug);
			if (existing) {
				existing.lastSeenMs = Math.max(existing.lastSeenMs, ms);
				existing.firstSeenMs = Math.min(existing.firstSeenMs, ms);
			} else {
				seen.set(slug, {
					slug,
					title: f.path,
					markdown: [
						`**File:** \`${f.path}\``,
						`**First seen:** ${c.author.date} (commit \`${shortSha(c.sha)}\`)`,
						"",
						"_Content not inlined — read the file directly in the repo._",
					].join("\n"),
					firstSeenMs: ms,
					lastSeenMs: ms,
				});
			}
		}
	}
	return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildDocOverview(
	repo: RepoEntry,
	ext: RepoExtract,
	history: GitHistoryExtract,
): string {
	const parts: string[] = [];
	if (ext.readme?.title) parts.push(`# ${ext.readme.title}`);
	if (ext.readme?.excerpt) parts.push(ext.readme.excerpt.slice(0, 2000));
	const meta: string[] = [
		`**Path:** \`${repo.path}\``,
		`**Stack:** ${repo.stack}`,
	];
	if (history.remote.url) meta.push(`**Remote:** ${history.remote.url}`);
	if (history.defaultBranch)
		meta.push(`**Default branch:** \`${history.defaultBranch}\``);
	if (repo.deployUrl) meta.push(`**Deploy:** ${repo.deployUrl}`);
	if (repo.port !== undefined) meta.push(`**Port:** ${repo.port}`);
	meta.push(
		`**Imported commits:** ${history.commits.length}${history.truncated ? " (truncated)" : ""}`,
	);
	meta.push(`**Sprints:** ${history.sprints.length}`);
	parts.push(meta.join("  \n"));
	return parts.filter(Boolean).join("\n\n");
}

function extractReadmeSection(
	excerpt: string | undefined,
	heading: string,
): string | null {
	if (!excerpt) return null;
	const lines = excerpt.split("\n");
	const startIdx = lines.findIndex((l) =>
		new RegExp(`^#{1,6}\\s+${heading}\\b`, "i").test(l),
	);
	if (startIdx === -1) return null;
	const startLevel = (lines[startIdx].match(/^#+/) ?? [""])[0].length;
	const out: string[] = [lines[startIdx]];
	for (let i = startIdx + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#+)\s+/);
		if (m && m[1].length <= startLevel) break;
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

function buildDefaultViews(folders: SpaceFolderPlan[]): ViewDef[] {
	const views: ViewDef[] = [];
	for (const folder of folders) {
		for (const list of folder.lists) {
			if (list.key === "bugs") {
				views.push({
					listKey: list.key,
					name: "Triage Board",
					type: "board",
					grouping: { field: "status" },
				});
				views.push({
					listKey: list.key,
					name: "Due-date Calendar",
					type: "calendar",
					sorting: { field: "due_date" },
				});
			} else if (list.key === "active_sprint") {
				views.push({
					listKey: list.key,
					name: "Sprint Board",
					type: "board",
					grouping: { field: "status" },
				});
				views.push({
					listKey: list.key,
					name: "Sprint Workload",
					type: "workload",
				});
				views.push({
					listKey: list.key,
					name: "Sprint Gantt",
					type: "gantt",
				});
			} else if (list.key === "in_review") {
				views.push({
					listKey: list.key,
					name: "Review Board",
					type: "board",
					grouping: { field: "tag" },
				});
			} else if (list.key === "agent_sessions") {
				views.push({
					listKey: list.key,
					name: "Sessions by Source",
					type: "list",
					grouping: { field: "tag" },
				});
			} else if (list.key.startsWith("sprint:")) {
				views.push({
					listKey: list.key,
					name: "By Type",
					type: "board",
					grouping: { field: "tag" },
				});
				views.push({
					listKey: list.key,
					name: "By Commit Date",
					type: "calendar",
					sorting: { field: "due_date" },
				});
			} else {
				views.push({
					listKey: list.key,
					name: "Default Board",
					type: "board",
					grouping: { field: "status" },
				});
			}
		}
	}
	return views;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

const CONVENTIONAL_PREFIX_RX =
	/^(feat|fix|docs|refactor|chore|style|perf|test|build|ci|revert|restructure)(\([^)]*\))?!?:\s*/i;
function stripConventionalPrefix(subject: string): string {
	return subject.replace(CONVENTIONAL_PREFIX_RX, "");
}

function msFromIso(iso: string | null | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : undefined;
}

const KEBAB_NORMALISE_RX = /[^a-z0-9]+/g;
function kebab(s: string): string {
	return s
		.toLowerCase()
		.replace(KEBAB_NORMALISE_RX, "-")
		.replace(/(^-|-$)/g, "");
}
