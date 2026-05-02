import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §K.2 + §K.3 — daily DM via CU notifications + opt-in weekly email
 * digest.
 *
 * Both surfaces are *opt-in* and *non-blocking*:
 *   - CU DM: we just write a comment mentioning the user on a per-author
 *     synthetic task in their inbox. Skips when email isn't a workspace
 *     member, or when scrum_config.members[email].notification_opt_out=true.
 *   - SMTP: skipped entirely when SMTP_HOST env var is unset (logged once
 *     in /health output as `smtp_configured=false`).
 *
 * Both rely on the daily groomer cron to fire them; this service is the
 * idempotency-aware writer.
 */

interface DailyDigestRow {
	email: string;
	commits24h: number;
	openSprintTasks: number;
	openBugs: number;
}

@Injectable()
export class DigestService {
	private readonly log = new Logger(DigestService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	/** Whether SMTP is configured (read by /health). */
	smtpConfigured(): boolean {
		return Boolean(process.env.SMTP_HOST);
	}

	async sendDailyDmsForProject(
		projectId: string,
	): Promise<{ sent: number; skipped: number }> {
		const project = await this.loadProjectMin(projectId);
		if (!project) return { sent: 0, skipped: 0 };

		const optOut = optOutSet(project.scrum_config);

		const rows = await this.computePerAuthor(projectId);
		let sent = 0;
		let skipped = 0;
		for (const row of rows) {
			if (optOut.has(row.email)) {
				skipped += 1;
				continue;
			}
			try {
				const memberId = await this.lookupMember(
					project.clickup_team_id,
					row.email,
				);
				if (!memberId) {
					skipped += 1;
					continue;
				}
				// CU's "in-app DM" — comment on the user-mention sentinel task
				// (the daily-triage task). Mention attribute targets the user.
				const triageTaskId = project.task_index?.["recurring:daily_triage"];
				if (!triageTaskId) {
					skipped += 1;
					continue;
				}
				const creds = await this.credentials.forOrg(project.organisation_id);
				await this.clickup.addStructuredComment(
					triageTaskId,
					[
						{
							text: " ",
							attributes: { mention: { user_id: memberId } },
						},
						{
							text: ` Daily digest — ${row.commits24h} commit(s), ${row.openSprintTasks} sprint task(s), ${row.openBugs} bug(s) in flight.`,
						},
					],
					creds.token,
					true,
				);
				sent += 1;
			} catch (err) {
				this.log.debug(
					`sendDailyDmsForProject(${row.email}): ${(err as Error).message}`,
				);
				skipped += 1;
			}
		}
		return { sent, skipped };
	}

	async sendWeeklyEmailDigest(
		projectId: string,
	): Promise<{ sent: number; skipped: number }> {
		if (!this.smtpConfigured()) return { sent: 0, skipped: 0 };
		// SMTP wiring (nodemailer or similar) is intentionally NOT included
		// in this PR — it would pull a heavy dep + need credentials. The
		// service signature is stable so a follow-up PR can plug nodemailer
		// in without changing the call surface.
		this.log.debug(`SMTP digest stub fired for project ${projectId}`);
		return { sent: 0, skipped: 0 };
	}

	// ── helpers ───────────────────────────────────────────────────────

	private async computePerAuthor(projectId: string): Promise<DailyDigestRow[]> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					email: string;
					commits24h: bigint | number;
				}>
			>(
				`SELECT LOWER(committer_email) AS email,
				        COUNT(*)::bigint AS commits24h
				 FROM clickup_tracker.git_events
				 WHERE project_id = $1::uuid
				   AND created_at > NOW() - INTERVAL '24 hours'
				   AND committer_email IS NOT NULL
				   AND committer_email <> ''
				 GROUP BY LOWER(committer_email)`,
				projectId,
			);
			return rows.map((r) => ({
				email: r.email,
				commits24h: Number(r.commits24h ?? 0),
				openSprintTasks: 0, // populated by future enrichment
				openBugs: 0,
			}));
		} catch (err) {
			this.log.debug(
				`computePerAuthor(${projectId}) failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	private async loadProjectMin(projectId: string): Promise<{
		id: string;
		organisation_id: string;
		clickup_team_id: string;
		task_index: Record<string, string> | null;
		scrum_config: Record<string, unknown> | null;
	} | null> {
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{
				id: string;
				organisation_id: string;
				clickup_team_id: string;
				task_index: Record<string, string> | null;
				scrum_config: Record<string, unknown> | null;
			}>
		>(
			`SELECT id, organisation_id, clickup_team_id, task_index, scrum_config
			 FROM clickup_tracker.projects
			 WHERE id = $1::uuid AND status = 'active'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async lookupMember(
		teamId: string,
		email: string,
	): Promise<number | null> {
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{ members_cache: Record<string, number> | null }>
		>(
			`SELECT members_cache FROM clickup_tracker.workspace_settings
			 WHERE clickup_team_id = $1
			 LIMIT 1`,
			teamId,
		);
		const cache = rows[0]?.members_cache ?? {};
		const lower = email.toLowerCase();
		return (
			cache[lower] ??
			cache[email] ??
			Object.entries(cache).find(([k]) => k.toLowerCase() === lower)?.[1] ??
			null
		);
	}
}

function optOutSet(scrumConfig: Record<string, unknown> | null): Set<string> {
	const out = new Set<string>();
	if (!scrumConfig) return out;
	const members = (scrumConfig as any).members as
		| Record<string, { notification_opt_out?: boolean }>
		| undefined;
	if (!members) return out;
	for (const [email, cfg] of Object.entries(members)) {
		if (cfg?.notification_opt_out) out.add(email.toLowerCase());
	}
	return out;
}

export { optOutSet };
