import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface Contributor {
	email: string;
	githubLogin: string | null;
	githubUrl: string | null;
	avatarUrl: string | null;
	stats: {
		commits30d: number;
		commitsAllTime: number;
		bugsOpened30d: number;
		bugsClosed30d: number;
		epicsTouched: string[];
		firstSeen: string | null;
		lastSeen: string | null;
	};
}

interface ContributorRow {
	email: string;
	github_login: string | null;
	github_url: string | null;
	avatar_url: string | null;
	commits_30d: bigint | number;
	commits_all_time: bigint | number;
	first_seen: Date | null;
	last_seen: Date | null;
}

/**
 * Plan §F.4 — aggregates per-author contribution stats across the project's
 * git_events, joined with the cached github_identities (Phase F.1) for
 * profile/avatar URLs. Output drives the `/projects/:id/contributors`
 * endpoint and (Phase G.3) the Contributors Doc page.
 */
@Injectable()
export class ContributorService {
	private readonly log = new Logger(ContributorService.name);

	constructor(private readonly prisma: PrismaService) {}

	async listForProject(projectId: string): Promise<Contributor[]> {
		const rows = await this.prisma.$queryRawUnsafe<ContributorRow[]>(
			`SELECT
			   COALESCE(g.committer_email, '') AS email,
			   gi.github_login,
			   gi.github_url,
			   gi.avatar_url,
			   COUNT(*) FILTER (
			     WHERE g.created_at > NOW() - INTERVAL '30 days'
			   )::bigint AS commits_30d,
			   COUNT(*)::bigint AS commits_all_time,
			   MIN(g.created_at) AS first_seen,
			   MAX(g.created_at) AS last_seen
			 FROM clickup_tracker.git_events g
			 LEFT JOIN clickup_tracker.github_identities gi
			   ON gi.email = LOWER(g.committer_email)
			 WHERE g.project_id = $1::uuid
			   AND g.committer_email IS NOT NULL
			   AND g.committer_email <> ''
			 GROUP BY g.committer_email, gi.github_login,
			          gi.github_url, gi.avatar_url
			 ORDER BY commits_all_time DESC, email ASC
			 LIMIT 200`,
			projectId,
		);

		return rows.map((r) => ({
			email: r.email,
			githubLogin: r.github_login,
			githubUrl: r.github_url,
			avatarUrl: r.avatar_url,
			stats: {
				commits30d: Number(r.commits_30d ?? 0),
				commitsAllTime: Number(r.commits_all_time ?? 0),
				bugsOpened30d: 0,
				bugsClosed30d: 0,
				epicsTouched: [],
				firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : null,
				lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
			},
		}));
	}
}

/**
 * Plan §G.3 — render a Contributors Doc page from a contributor list. Pure
 * (no I/O) so it's trivially testable and reusable by both backfill and the
 * nightly refresh cron.
 */
export function renderContributorsMd(contributors: Contributor[]): string {
	const lines: string[] = [];
	lines.push("# Contributors");
	lines.push("");
	lines.push(
		"_Auto-managed by clickup-tracker — refreshed on each commit and nightly._",
	);
	lines.push("");
	if (contributors.length === 0) {
		lines.push("_No contributors yet — waiting for the first commit._");
		return lines.join("\n");
	}
	lines.push("| Contributor | Commits (30d) | Total | First | Last |");
	lines.push("|---|---|---|---|---|");
	for (const c of contributors) {
		const who =
			c.githubLogin && c.githubUrl
				? (c.avatarUrl ? `![](${c.avatarUrl}) ` : "") +
					`[${c.githubLogin}](${c.githubUrl}) — \`${c.email}\``
				: `\`${c.email}\``;
		const first = c.stats.firstSeen ? c.stats.firstSeen.slice(0, 10) : "—";
		const last = c.stats.lastSeen ? c.stats.lastSeen.slice(0, 10) : "—";
		lines.push(
			`| ${who} | ${c.stats.commits30d} | ${c.stats.commitsAllTime} | ${first} | ${last} |`,
		);
	}
	return lines.join("\n");
}
