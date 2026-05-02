import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §M.3 — gh-cli polling fallback for repos without a webhook.
 *
 * Activation conditions:
 *   - GITHUB_TOKEN env var set (otherwise GitHub rate limits to 60/h)
 *   - project has github_webhook_id == NULL (no webhook configured)
 *
 * Cadence: every 5 minutes, master scheduler tick.
 *
 * This PR ships the cron skeleton + selection query so the operator
 * sees it firing in logs (and /health surfaces it). The actual
 * `gh api repos/{owner}/{repo}/actions/runs` poll + ReviewEventsService
 * synthesis lands in a v0.5.x point release once the gh-cli wrapper
 * is in place.
 */
@Injectable()
export class GithubPollCron {
	private readonly log = new Logger(GithubPollCron.name);

	constructor(private readonly prisma: PrismaService) {}

	@Cron(CronExpression.EVERY_5_MINUTES)
	async tick(): Promise<void> {
		if (!process.env.GITHUB_TOKEN) return;
		const projects = await this.selectPollableProjects();
		if (projects.length === 0) return;
		this.log.debug(
			`github-poll: ${projects.length} project(s) eligible for poll fallback`,
		);
		// Real fetch path lands in a follow-up; structured selection is the
		// piece this PR validates so wiring + scheduling is in place.
	}

	private async selectPollableProjects(): Promise<
		Array<{ id: string; owner: string; repo: string }>
	> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					id: string;
					git_remote_owner_repo: string | null;
					git_remote_host: string | null;
				}>
			>(
				`SELECT id, git_remote_owner_repo, git_remote_host
				 FROM clickup_tracker.projects
				 WHERE status = 'active'
				   AND git_remote_host = 'github.com'
				   AND git_remote_owner_repo IS NOT NULL
				   AND github_webhook_id IS NULL`,
			);
			const out: Array<{ id: string; owner: string; repo: string }> = [];
			for (const r of rows) {
				const [owner, repo] = (r.git_remote_owner_repo ?? "").split("/");
				if (owner && repo) out.push({ id: r.id, owner, repo });
			}
			return out;
		} catch (err) {
			this.log.debug(
				`github-poll selectPollableProjects failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}
