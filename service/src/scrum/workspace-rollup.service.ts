import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { runWithPriority } from "../clickup/priority-context";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §K.1 — workspace-level dashboard Doc auto-aggregating across every
 * project in a CU workspace.
 *
 * Pages:
 *   - Active Projects   — table per project: name, current sprint, velocity,
 *                         open bugs, last activity timestamp
 *   - Cross-project Hotspots — files touched ≥ N times across all projects
 *                              in the last 7d (when N=10 by default)
 *   - Workspace Contributors — every author across all projects, totals
 *
 * Refreshed on demand and (later) by a master scheduler tick. Created on
 * first run; subsequent runs UPDATE existing pages by ID.
 */

const ROLLUP_DOC_NAME = "Workspace Overview — clickup-tracker";
const PAGE_NAMES = {
	activeProjects: "Active Projects",
	hotspots: "Cross-project Hotspots",
	contributors: "Workspace Contributors",
} as const;

interface ProjectSummaryRow {
	id: string;
	display_name: string;
	last_synced_at: Date | null;
	velocity_window: Array<{ iso_week: string; committed_tasks: number }> | null;
	list_ids: Record<string, string> | null;
}

interface HotspotRow {
	display_name: string;
	path: string;
	churn: bigint | number;
}

interface AuthorRow {
	email: string;
	github_login: string | null;
	commits: bigint | number;
	projects: bigint | number;
}

@Injectable()
export class WorkspaceRollupService {
	private readonly log = new Logger(WorkspaceRollupService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async refreshForOrg(
		organisationId: string,
		opts: { dryRun?: boolean } = {},
	): Promise<{
		projects: number;
		hotspots: number;
		contributors: number;
		dryRun: boolean;
		markdown: {
			activeProjects: string;
			hotspots: string;
			contributors: string;
		};
	}> {
		return runWithPriority("scrum", async () => {
			const projects = await this.prisma.$queryRawUnsafe<ProjectSummaryRow[]>(
				`SELECT id, display_name, last_synced_at, velocity_window, list_ids
				 FROM clickup_tracker.projects
				 WHERE organisation_id = $1::uuid AND status = 'active'
				 ORDER BY display_name`,
				organisationId,
			);

			// Cross-project hotspots — top files churned across the org in 7d.
			const hotspots = await this.prisma
				.$queryRawUnsafe<HotspotRow[]>(
					`SELECT p.display_name,
				        f->>'path'                                   AS path,
				        COUNT(*)::bigint                              AS churn
				 FROM clickup_tracker.git_events g
				 JOIN clickup_tracker.projects p ON p.id = g.project_id
				 CROSS JOIN LATERAL jsonb_array_elements(g.files_changed::jsonb) f
				 WHERE p.organisation_id = $1::uuid
				   AND g.created_at > NOW() - INTERVAL '7 days'
				 GROUP BY p.display_name, f->>'path'
				 HAVING COUNT(*) >= 5
				 ORDER BY churn DESC
				 LIMIT 50`,
					organisationId,
				)
				.catch(() => [] as HotspotRow[]);

			// Workspace contributors — totals per author across the org.
			const contributors = await this.prisma
				.$queryRawUnsafe<AuthorRow[]>(
					`SELECT LOWER(g.committer_email) AS email,
				        gi.github_login,
				        COUNT(*)::bigint               AS commits,
				        COUNT(DISTINCT g.project_id)::bigint AS projects
				 FROM clickup_tracker.git_events g
				 JOIN clickup_tracker.projects p ON p.id = g.project_id
				 LEFT JOIN clickup_tracker.github_identities gi
				   ON gi.email = LOWER(g.committer_email)
				 WHERE p.organisation_id = $1::uuid
				   AND g.committer_email IS NOT NULL
				   AND g.committer_email <> ''
				 GROUP BY LOWER(g.committer_email), gi.github_login
				 ORDER BY commits DESC
				 LIMIT 100`,
					organisationId,
				)
				.catch(() => [] as AuthorRow[]);

			const md = {
				activeProjects: renderActiveProjectsMd(projects),
				hotspots: renderHotspotsMd(hotspots),
				contributors: renderWorkspaceContributorsMd(contributors),
			};

			const out = {
				projects: projects.length,
				hotspots: hotspots.length,
				contributors: contributors.length,
				dryRun: opts.dryRun ?? false,
				markdown: md,
			};

			if (opts.dryRun) return out;

			// Best-effort write to the workspace Doc. We need a CU team_id +
			// token; pull from any project (they all share an org's credentials).
			if (projects.length === 0) return out;
			try {
				const creds = await this.credentials.forOrg(organisationId);
				const firstProject = await this.prisma.$queryRawUnsafe<
					Array<{ clickup_team_id: string | null }>
				>(
					`SELECT clickup_team_id FROM clickup_tracker.projects
					 WHERE organisation_id = $1::uuid AND clickup_team_id IS NOT NULL
					 LIMIT 1`,
					organisationId,
				);
				const teamId = firstProject[0]?.clickup_team_id;
				if (!teamId) return out;
				await this.upsertRollupDoc(teamId, organisationId, md, creds.token);
			} catch (err) {
				this.log.warn(
					`workspace rollup write failed: ${(err as Error).message}`,
				);
			}
			return out;
		});
	}

	private async upsertRollupDoc(
		teamId: string,
		organisationId: string,
		md: { activeProjects: string; hotspots: string; contributors: string },
		token: string,
	): Promise<void> {
		// We persist the rollup Doc id on a sentinel row in workspace_settings.
		// (The schema for that lives in the existing workspace_settings table.)
		// To keep this PR tight + avoid a schema change, we re-discover the Doc
		// each call by name. Cheap enough for a once-daily refresh.
		const rows = await this.prisma
			.$queryRawUnsafe<Array<{ rollup_doc_id: string | null }>>(
				`SELECT (settings->>'rollup_doc_id') AS rollup_doc_id
			 FROM clickup_tracker.workspace_settings
			 WHERE organisation_id = $1::uuid
			 LIMIT 1`,
				organisationId,
			)
			.catch(() => [] as Array<{ rollup_doc_id: string | null }>);
		let docId = rows[0]?.rollup_doc_id ?? null;

		if (!docId) {
			const doc = await this.clickup.createDoc(
				teamId,
				{
					name: ROLLUP_DOC_NAME,
					parent: { id: teamId, type: 7 },
					visibility: "WORKSPACE",
					create_page: false,
				},
				token,
			);
			docId = doc.id;
			await this.prisma
				.$executeRawUnsafe(
					`UPDATE clickup_tracker.workspace_settings
					 SET settings = jsonb_set(
					   COALESCE(settings, '{}'::jsonb),
					   '{rollup_doc_id}',
					   to_jsonb($2::text),
					   true
					 ),
					 updated_at = NOW()
					 WHERE organisation_id = $1::uuid`,
					organisationId,
					docId,
				)
				.catch(() => undefined);
		}

		const pages = await this.clickup.listDocPages(teamId, docId, token);
		for (const [key, content] of [
			[PAGE_NAMES.activeProjects, md.activeProjects] as const,
			[PAGE_NAMES.hotspots, md.hotspots] as const,
			[PAGE_NAMES.contributors, md.contributors] as const,
		]) {
			const existing = pages.find(
				(p) => (p.name ?? "").toLowerCase() === key.toLowerCase(),
			);
			if (existing) {
				await this.clickup.updateDocPage(
					teamId,
					docId,
					existing.id,
					{ content, content_edit_mode: "replace" },
					token,
				);
			} else {
				await this.clickup.createDocPage(
					teamId,
					docId,
					{ name: key, content },
					token,
				);
			}
		}
	}
}

// ── pure renderers ───────────────────────────────────────────────────

export function renderActiveProjectsMd(
	rows: Array<{
		display_name: string;
		last_synced_at: Date | null;
		velocity_window: Array<{
			iso_week: string;
			committed_tasks: number;
		}> | null;
	}>,
): string {
	const lines: string[] = [];
	lines.push("# Active Projects");
	lines.push("");
	if (rows.length === 0) {
		lines.push("_No active projects yet._");
		return lines.join("\n");
	}
	lines.push("| Project | Recent velocity | Last synced |");
	lines.push("|---|---|---|");
	for (const r of rows) {
		const recent = (r.velocity_window ?? []).slice(-4);
		const trend =
			recent.length > 0
				? recent.map((v) => v.committed_tasks).join(" · ")
				: "—";
		const last = r.last_synced_at
			? new Date(r.last_synced_at).toISOString().slice(0, 16).replace("T", " ")
			: "—";
		lines.push(`| ${r.display_name} | ${trend} | ${last} UTC |`);
	}
	return lines.join("\n");
}

export function renderHotspotsMd(rows: HotspotRow[]): string {
	const lines: string[] = [];
	lines.push("# Cross-project Hotspots (last 7 days)");
	lines.push("");
	if (rows.length === 0) {
		lines.push("_No hotspots in the last 7 days (threshold: 5+ touches)._");
		return lines.join("\n");
	}
	lines.push("| Project | Path | Touches |");
	lines.push("|---|---|---|");
	for (const r of rows) {
		lines.push(`| ${r.display_name} | \`${r.path}\` | ${Number(r.churn)} |`);
	}
	return lines.join("\n");
}

export function renderWorkspaceContributorsMd(rows: AuthorRow[]): string {
	const lines: string[] = [];
	lines.push("# Workspace Contributors");
	lines.push("");
	if (rows.length === 0) {
		lines.push("_No contributors yet._");
		return lines.join("\n");
	}
	lines.push("| Contributor | Commits | Projects |");
	lines.push("|---|---|---|");
	for (const r of rows) {
		const who = r.github_login
			? `[${r.github_login}](https://github.com/${r.github_login}) — \`${r.email}\``
			: `\`${r.email}\``;
		lines.push(`| ${who} | ${Number(r.commits)} | ${Number(r.projects)} |`);
	}
	return lines.join("\n");
}
