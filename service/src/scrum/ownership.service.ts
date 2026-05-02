import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §I.4-I.5 — per-file ownership map (CODEOWNERS-style learned).
 *
 * Computes a per-(project,file,email) ownership score weighted by recency:
 *   - line deltas in the last 90 days  → weight 1.0
 *   - line deltas in the last 180 days → weight 0.5
 *   - older                            → weight 0.25
 *
 * The score = sum(weight × deltas). Top-N owners per file feed:
 *   - the Ownership Doc page (I.5)
 *   - reviewer suggestions (Phase K.5, PR-11)
 *
 * Backed by the `git_events.files_changed` JSONB column which stores
 * `[{ path, additions, deletions, status, deltas }, ...]`. We re-derive
 * deltas as `additions + deletions` defensively.
 */
@Injectable()
export class OwnershipService {
	private readonly log = new Logger(OwnershipService.name);

	constructor(private readonly prisma: PrismaService) {}

	async topOwnersForPath(
		projectId: string,
		path: string,
		limit = 3,
	): Promise<FileOwner[]> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<OwnerRow[]>(
				ownerSql({ singlePath: true }),
				projectId,
				path,
				limit,
			);
			return rows.map(rowToOwner);
		} catch (err) {
			this.log.debug(
				`topOwnersForPath(${path}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	async topOwnersForProject(
		projectId: string,
		opts: { topN?: number; pathLimit?: number } = {},
	): Promise<Map<string, FileOwner[]>> {
		const topN = opts.topN ?? 3;
		const pathLimit = opts.pathLimit ?? 200;
		const out = new Map<string, FileOwner[]>();
		try {
			const rows = await this.prisma.$queryRawUnsafe<OwnerRow[]>(
				ownerSql({ singlePath: false }),
				projectId,
				topN,
				pathLimit,
			);
			for (const r of rows) {
				const owner = rowToOwner(r);
				const arr = out.get(r.path) ?? [];
				arr.push(owner);
				out.set(r.path, arr);
			}
		} catch (err) {
			this.log.debug(
				`topOwnersForProject(${projectId}) failed: ${(err as Error).message}`,
			);
		}
		return out;
	}
}

export interface FileOwner {
	email: string;
	score: number;
	lastTouchedAt: string | null;
	commits: number;
}

interface OwnerRow {
	path: string;
	email: string;
	score: string | number;
	last_touched_at: Date | null;
	commits: bigint | number;
}

function rowToOwner(r: OwnerRow): FileOwner {
	return {
		email: r.email,
		score: Number(r.score ?? 0),
		lastTouchedAt: r.last_touched_at
			? new Date(r.last_touched_at).toISOString()
			: null,
		commits: Number(r.commits ?? 0),
	};
}

interface SqlOpts {
	singlePath: boolean;
}

/**
 * Two query shapes:
 *   - singlePath=true:  ($1=projectId, $2=path,    $3=limit) → top-N for one path
 *   - singlePath=false: ($1=projectId, $2=topN,    $3=pathLimit) → top-N per path,
 *                         capped to first pathLimit paths by total churn
 *
 * The recency weight comes from a CASE expression on g.created_at; deltas are
 * jsonb-extracted from each entry of g.files_changed.
 */
function ownerSql(opts: SqlOpts): string {
	const filterByPath = opts.singlePath ? "AND f.path = $2" : "";
	const limitClause = opts.singlePath
		? "LIMIT $3"
		: // ranked partition keeps top-$2 per path; outer cap is $3
			"";
	if (opts.singlePath) {
		return `
			WITH per_file AS (
				SELECT (jsonb_array_elements(g.files_changed::jsonb)->>'path')      AS path,
				       LOWER(g.committer_email)                                     AS email,
				       COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'additions')::int, 0)
				         + COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'deletions')::int, 0) AS deltas,
				       g.created_at,
				       CASE
				         WHEN g.created_at > NOW() - INTERVAL '90 days'  THEN 1.0
				         WHEN g.created_at > NOW() - INTERVAL '180 days' THEN 0.5
				         ELSE 0.25
				       END AS weight
				FROM clickup_tracker.git_events g
				WHERE g.project_id = $1::uuid
				  AND g.committer_email IS NOT NULL
				  AND g.committer_email <> ''
				  AND g.files_changed IS NOT NULL
			)
			SELECT path,
			       email,
			       SUM(weight * deltas)::numeric AS score,
			       MAX(created_at) AS last_touched_at,
			       COUNT(*)::bigint AS commits
			FROM per_file f
			WHERE 1=1 ${filterByPath}
			GROUP BY path, email
			ORDER BY score DESC
			${limitClause}
		`;
	}
	return `
		WITH per_file AS (
			SELECT (jsonb_array_elements(g.files_changed::jsonb)->>'path')      AS path,
			       LOWER(g.committer_email)                                     AS email,
			       COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'additions')::int, 0)
			         + COALESCE((jsonb_array_elements(g.files_changed::jsonb)->>'deletions')::int, 0) AS deltas,
			       g.created_at,
			       CASE
			         WHEN g.created_at > NOW() - INTERVAL '90 days'  THEN 1.0
			         WHEN g.created_at > NOW() - INTERVAL '180 days' THEN 0.5
			         ELSE 0.25
			       END AS weight
			FROM clickup_tracker.git_events g
			WHERE g.project_id = $1::uuid
			  AND g.committer_email IS NOT NULL
			  AND g.committer_email <> ''
			  AND g.files_changed IS NOT NULL
		),
		scored AS (
			SELECT path,
			       email,
			       SUM(weight * deltas)::numeric AS score,
			       MAX(created_at) AS last_touched_at,
			       COUNT(*)::bigint AS commits
			FROM per_file
			GROUP BY path, email
		),
		ranked AS (
			SELECT *,
			       ROW_NUMBER() OVER (PARTITION BY path ORDER BY score DESC) AS rn,
			       SUM(score) OVER (PARTITION BY path) AS total_score
			FROM scored
		),
		top_paths AS (
			SELECT path
			FROM (SELECT DISTINCT path, total_score FROM ranked) t
			ORDER BY total_score DESC
			LIMIT $3
		)
		SELECT r.path, r.email, r.score, r.last_touched_at, r.commits
		FROM ranked r
		WHERE r.rn <= $2
		  AND r.path IN (SELECT path FROM top_paths)
		ORDER BY r.path ASC, r.score DESC
	`;
}

/**
 * Plan §I.5 — render the Ownership Doc page from a top-owners map.
 * Pure (no I/O). Format: collapsible per top-level dir grouping the
 * paths underneath, each with its top-3 owner emails + last touched.
 */
export function renderOwnershipMd(owners: Map<string, FileOwner[]>): string {
	const lines: string[] = [];
	lines.push("# Ownership");
	lines.push("");
	lines.push(
		"_Auto-managed by clickup-tracker — refreshed nightly by the groomer. " +
			"Top owners per file, ranked by recency-weighted line deltas._",
	);
	lines.push("");
	if (owners.size === 0) {
		lines.push("_No commits yet — waiting for first ingestion._");
		return lines.join("\n");
	}

	// Group by top-level directory so the page collapses cleanly.
	const groups = new Map<string, string[]>();
	for (const path of owners.keys()) {
		const top = path.split("/")[0] || "(root)";
		const arr = groups.get(top) ?? [];
		arr.push(path);
		groups.set(top, arr);
	}
	const sortedGroups = [...groups.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	for (const [topDir, paths] of sortedGroups) {
		lines.push(
			`<details><summary><strong>${topDir}/</strong> (${paths.length} files)</summary>`,
		);
		lines.push("");
		lines.push("| Path | Top owners | Last touched |");
		lines.push("|---|---|---|");
		for (const path of paths.sort()) {
			const list = owners.get(path) ?? [];
			const ownerCell = list
				.map((o) => `\`${o.email}\` (${o.score.toFixed(0)})`)
				.join(", ");
			const last = list[0]?.lastTouchedAt
				? list[0].lastTouchedAt.slice(0, 10)
				: "—";
			lines.push(`| \`${path}\` | ${ownerCell || "_unknown_"} | ${last} |`);
		}
		lines.push("");
		lines.push("</details>");
		lines.push("");
	}
	return lines.join("\n");
}
