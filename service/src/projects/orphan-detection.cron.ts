import { HttpException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §B.8 — orphan-Space detection.
 *
 * When a developer wipes a project from CU manually (deletes the Space)
 * but leaves the daemon running, every subsequent write 404s. We can't
 * receive a "spaceDeleted" webhook reliably (CU only emits task-level
 * events), so we poll: every 30 minutes, ping each active project's
 * Space. On 404, flip status from 'active' → 'orphaned' so the daemon
 * stops trying to write to it. Recovery: the operator either restores
 * the Space in CU (then `PATCH /projects/:id` to flip back) or runs
 * `/clickup-add` to create a fresh project row.
 *
 * Idempotent + cheap:
 *   - bounded to 50 projects per tick (most workspaces have far fewer).
 *   - failures other than 404 (auth, rate-limit, network) are logged
 *     and tried again on the next tick — never flip status on those.
 *   - re-flipping an already-orphaned project is a no-op (filtered).
 */

interface ProjectProbeRow {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_team_id: string;
	clickup_space_id: string;
}

@Injectable()
export class OrphanDetectionCron {
	private readonly log = new Logger(OrphanDetectionCron.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	@Cron(CronExpression.EVERY_30_MINUTES)
	async tick(): Promise<void> {
		if (process.env.CUP_ORPHAN_DETECTION === "off") return;
		const projects = await this.fetchProbeable();
		if (projects.length === 0) return;
		this.log.debug(
			`orphan-detection tick: probing ${projects.length} project(s)`,
		);
		for (const p of projects) {
			await this.probeOne(p);
		}
	}

	async probeOne(p: ProjectProbeRow): Promise<"ok" | "orphaned" | "skipped"> {
		let token: string;
		try {
			const creds = await this.credentials.forOrg(p.organisation_id);
			token = creds.token;
		} catch (err) {
			this.log.debug(
				`orphan-detection ${p.id}: no credentials (${(err as Error).message})`,
			);
			return "skipped";
		}

		try {
			await this.clickup.getSpace(p.clickup_space_id, token);
			return "ok";
		} catch (err) {
			const status = err instanceof HttpException ? err.getStatus() : 0;
			if (status === 404) {
				await this.markOrphaned(p);
				return "orphaned";
			}
			// Anything else (401, 429, 5xx, network) → leave alone, retry next tick.
			this.log.debug(
				`orphan-detection ${p.id}: probe error ${status} (${(err as Error).message}) — leaving status untouched`,
			);
			return "skipped";
		}
	}

	private async markOrphaned(p: ProjectProbeRow): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`UPDATE clickup_tracker.projects
         SET status = 'orphaned', updated_at = NOW()
         WHERE id = $1::uuid AND status = 'active'`,
				p.id,
			);
			this.log.warn(
				`orphan-detection: project ${p.id} (${p.display_name}) Space ${p.clickup_space_id} returned 404 — flipped status to 'orphaned'`,
			);
		} catch (err) {
			this.log.warn(
				`orphan-detection: failed to mark ${p.id} orphaned: ${(err as Error).message}`,
			);
		}
	}

	private async fetchProbeable(): Promise<ProjectProbeRow[]> {
		try {
			return await this.prisma.$queryRawUnsafe<ProjectProbeRow[]>(
				`SELECT id, organisation_id, display_name,
                clickup_team_id, clickup_space_id
         FROM clickup_tracker.projects
         WHERE status = 'active'
           AND clickup_space_id IS NOT NULL
           AND clickup_space_id <> ''
         LIMIT 50`,
			);
		} catch (err) {
			this.log.warn(
				`orphan-detection fetchProbeable failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}
