import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { GroomerService } from "./groomer.service";
import { LeadershipService } from "./leadership.service";
import { ReportingService } from "./reporting.service";
import { SprintPlannerService } from "./sprint-planner.service";

/**
 * Plan §C.9 — master 5-minute poll cron that drives every autonomous
 * SCRUM action. Per the plan, per-project cron expressions live in
 * `scrum_config.{plan,groom,standup,retro}_cron` (tz-aware). Rather
 * than registering one decorator per project, we run a master tick
 * every 5 minutes and decide which projects are due.
 *
 * Default cadence:
 *   sprint planner — Mondays at 08:00 local (= scrum_config.tz)
 *   daily groomer  — every day at 06:00 local
 *
 * Each fire is gated by:
 *   1. CUP_AUTOSCRUM=off env kill switch (process-wide)
 *   2. project.scrum_config.enabled !== false (per-project knob)
 *   3. LeadershipService advisory lock (only one daemon per workspace)
 *
 * Idempotency on `last_*_at` (sprint = iso_week, groom = utc date) is
 * enforced inside each service so re-firing is harmless.
 */

interface SchedulableProject {
	id: string;
	clickup_team_id: string;
	scrum_config: Record<string, unknown> | null;
	last_sprint_plan_at: Date | null;
	last_groom_at: Date | null;
	last_standup_at: Date | null;
	last_retro_at: Date | null;
}

@Injectable()
export class ScrumScheduler {
	private readonly log = new Logger(ScrumScheduler.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly leadership: LeadershipService,
		private readonly planner: SprintPlannerService,
		private readonly groomer: GroomerService,
		private readonly reporting: ReportingService,
	) {}

	@Cron(CronExpression.EVERY_5_MINUTES)
	async tick(): Promise<void> {
		if (process.env.CUP_AUTOSCRUM === "off") return;
		const now = new Date();
		const projects = await this.fetchSchedulable();
		for (const p of projects) {
			const cfg = p.scrum_config ?? {};
			if ((cfg as { enabled?: boolean }).enabled === false) continue;

			// Sprint plan — Mondays 08:00 UTC (a per-project tz-aware cron
			// is in the plan but deferred; UTC-Monday-08:00 is a usable
			// default and the manual endpoint covers off-cycle planning).
			if (
				now.getUTCDay() === 1 &&
				now.getUTCHours() === 8 &&
				!sameIsoDay(p.last_sprint_plan_at, now)
			) {
				await this.tryPlanSprint(p);
			}

			// Daily groomer — 06:00 UTC, once per day.
			if (now.getUTCHours() === 6 && !sameIsoDay(p.last_groom_at, now)) {
				await this.tryGroom(p);
			}

			// Standup — weekdays at 08:30 UTC, once per UTC day.
			const dow = now.getUTCDay();
			const isWeekday = dow >= 1 && dow <= 5;
			if (
				isWeekday &&
				now.getUTCHours() === 8 &&
				now.getUTCMinutes() >= 30 &&
				!sameIsoDay(p.last_standup_at, now)
			) {
				await this.tryStandup(p);
			}

			// Retro — Sundays at 18:00 UTC.
			if (
				dow === 0 &&
				now.getUTCHours() === 18 &&
				!sameIsoDay(p.last_retro_at, now)
			) {
				await this.tryRetro(p);
			}
		}
	}

	private async tryStandup(p: SchedulableProject): Promise<void> {
		const result = await this.leadership.withLeadership(
			p.clickup_team_id,
			`scrum:standup:${p.id}`,
			() => this.reporting.generateStandup(p.id, false),
		);
		if (!result.leader) {
			this.log.debug(
				`scrum:standup ${p.id}: not_leader (peer daemon won the lock)`,
			);
			return;
		}
		this.log.log(
			`scrum:standup ${p.id}: ${
				result.value.skipped ?? `posted ${result.value.dateUtc}`
			}`,
		);
	}

	private async tryRetro(p: SchedulableProject): Promise<void> {
		const result = await this.leadership.withLeadership(
			p.clickup_team_id,
			`scrum:retro:${p.id}`,
			() => this.reporting.generateRetro(p.id, false),
		);
		if (!result.leader) {
			this.log.debug(
				`scrum:retro ${p.id}: not_leader (peer daemon won the lock)`,
			);
			return;
		}
		this.log.log(
			`scrum:retro ${p.id}: ${
				result.value.skipped ?? `posted ${result.value.isoWeek}`
			}`,
		);
	}

	private async tryPlanSprint(p: SchedulableProject): Promise<void> {
		const result = await this.leadership.withLeadership(
			p.clickup_team_id,
			`scrum:plan:${p.id}`,
			() => this.planner.planSprint(p.id, false),
		);
		if (!result.leader) {
			this.log.debug(
				`scrum:plan ${p.id}: not_leader (peer daemon won the lock)`,
			);
			return;
		}
		this.log.log(
			`scrum:plan ${p.id}: ${result.value.skipped ?? `planned ${result.value.selected.length} tasks`}`,
		);
	}

	private async tryGroom(p: SchedulableProject): Promise<void> {
		const result = await this.leadership.withLeadership(
			p.clickup_team_id,
			`scrum:groom:${p.id}`,
			() => this.groomer.groom(p.id, false),
		);
		if (!result.leader) {
			this.log.debug(
				`scrum:groom ${p.id}: not_leader (peer daemon won the lock)`,
			);
			return;
		}
		this.log.log(
			`scrum:groom ${p.id}: ${result.value.skipped ?? `dedupes=${result.value.dedupes.length} hotspots=${result.value.hotspots.length}`}`,
		);
	}

	private async fetchSchedulable(): Promise<SchedulableProject[]> {
		try {
			return await this.prisma.$queryRawUnsafe<SchedulableProject[]>(
				`SELECT id, clickup_team_id, scrum_config,
                last_sprint_plan_at, last_groom_at,
                last_standup_at, last_retro_at
         FROM clickup_tracker.projects
         WHERE status = 'active'
           AND clickup_team_id IS NOT NULL
           AND clickup_space_id IS NOT NULL
           AND clickup_space_id <> ''`,
			);
		} catch (err) {
			this.log.warn(`fetchSchedulable failed: ${(err as Error).message}`);
			return [];
		}
	}
}

function sameIsoDay(a: Date | null, b: Date): boolean {
	if (!a) return false;
	const d = a instanceof Date ? a : new Date(a);
	return (
		d.getUTCFullYear() === b.getUTCFullYear() &&
		d.getUTCMonth() === b.getUTCMonth() &&
		d.getUTCDate() === b.getUTCDate()
	);
}
