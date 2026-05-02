import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { LeadershipService } from "../scrum/leadership.service";
import { DeploymentMirrorService } from "./deployment-mirror.service";
import { RailwayApiService } from "./railway.service";

/**
 * Plan §N.3 — every 2 min, walk every active project bound to a Railway
 * project + service and mirror each new deployment as a CU task.
 *
 *   precondition  RAILWAY_API_TOKEN env set
 *   leadership    "railway:poll" advisory lock per project (xact-scope)
 *   idempotency   railway_deployments PK on Railway deployment id
 *
 * Skips entirely (no log) when the token is unset; otherwise logs at
 * debug for each project polled.
 */
@Injectable()
export class RailwayPollCron {
	private readonly log = new Logger(RailwayPollCron.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly api: RailwayApiService,
		private readonly mirror: DeploymentMirrorService,
		private readonly leadership: LeadershipService,
	) {}

	@Cron(CronExpression.EVERY_30_SECONDS)
	async tick(): Promise<void> {
		// Cron triggers every 30s but the body throttles to ~2 min by
		// gating on `last_railway_poll_at` so a fleet of leaders can't
		// double-poll Railway and exhaust the rate-limit budget.
		if (!this.api.configured) return;
		const projects = await this.selectBoundProjects();
		if (projects.length === 0) return;
		for (const p of projects) {
			const result = await this.leadership.withLeadership(
				p.id,
				"railway:poll",
				async () => {
					await this.pollOne(p);
					await this.markPolled(p.id);
					return true;
				},
			);
			if (!result.leader) {
				this.log.debug(`railway-poll: skipping ${p.id} (not_leader)`);
			}
		}
	}

	private async pollOne(project: BoundProjectRow): Promise<void> {
		const since = staleness(project.last_railway_poll_at);
		let mirroredAny = false;
		for (const serviceId of project.railway_service_ids) {
			let deployments;
			try {
				deployments = await this.api.listDeployments({
					projectId: project.railway_project_id,
					serviceId,
					since,
					limit: 25,
				});
			} catch (err) {
				this.log.debug(
					`railway-poll list ${project.id}/${serviceId} failed: ${(err as Error).message}`,
				);
				continue;
			}
			for (const dep of deployments) {
				try {
					await this.mirror.mirror(project.id, dep);
					mirroredAny = true;
				} catch (err) {
					this.log.debug(
						`railway-poll mirror ${dep.id} failed: ${(err as Error).message}`,
					);
				}
			}
		}
		// Plan §N.9 — refresh the Deployments Doc page once per cycle, only
		// if at least one deployment was mirrored (avoids hammering CU).
		if (mirroredAny) {
			await this.mirror.refreshDocPage(project.id);
		}
	}

	private async markPolled(projectId: string): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
				 SET last_railway_poll_at = NOW()
				 WHERE id = $1::uuid`,
				projectId,
			);
		} catch {
			/* best-effort */
		}
	}

	private async selectBoundProjects(): Promise<BoundProjectRow[]> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					id: string;
					railway_project_id: string;
					railway_service_ids: string[] | null;
					last_railway_poll_at: Date | null;
				}>
			>(
				`SELECT id, railway_project_id, railway_service_ids,
				        last_railway_poll_at
				 FROM clickup_tracker.projects
				 WHERE status = 'active'
				   AND railway_project_id IS NOT NULL
				   AND COALESCE(jsonb_array_length(railway_service_ids), 0) > 0
				   AND (last_railway_poll_at IS NULL
				        OR last_railway_poll_at < NOW() - INTERVAL '2 minutes')`,
			);
			return rows.map((r) => ({
				id: r.id,
				railway_project_id: r.railway_project_id,
				railway_service_ids: Array.isArray(r.railway_service_ids)
					? r.railway_service_ids
					: [],
				last_railway_poll_at: r.last_railway_poll_at,
			}));
		} catch (err) {
			this.log.debug(
				`railway-poll selectBoundProjects failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}

interface BoundProjectRow {
	id: string;
	railway_project_id: string;
	railway_service_ids: string[];
	last_railway_poll_at: Date | null;
}

/**
 * `since` for the GraphQL query — go back to the previous poll (or 24h
 * for cold starts). Returning `undefined` means "no time floor" which
 * combined with `first: 25` yields the most recent 25 deploys.
 */
export function staleness(last: Date | null): Date {
	if (last) return new Date(last.getTime() - 60_000);
	return new Date(Date.now() - 24 * 3600 * 1000);
}
