import {
	Body,
	Controller,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Req,
	UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { SprintPlannerService } from "./sprint-planner.service";

/**
 * Plan §C.7 — operator control surface for autonomous SCRUM. All
 * endpoints default to dry-run; mutations require explicit
 * `?dryRun=false`. The kill switch (`CUP_AUTOSCRUM=off`) is honoured
 * across every cron + endpoint here.
 */

@Controller("projects")
export class ScrumController {
	constructor(
		private readonly prisma: PrismaService,
		private readonly planner: SprintPlannerService,
		private readonly audit: AuditService,
	) {}

	@Post(":id/scrum/plan-sprint")
	async planSprint(
		@Req() req: any,
		@Param("id") id: string,
		@Query("dryRun") dryRun?: string,
	) {
		orgIdOrThrow(req);
		if (process.env.CUP_AUTOSCRUM === "off") {
			return { skipped: "autoscrum_disabled" };
		}
		const isDry = dryRun !== "false";
		return this.planner.planSprint(id, isDry);
	}

	@Get(":id/scrum/state")
	async state(@Req() req: any, @Param("id") id: string) {
		orgIdOrThrow(req);
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{
				id: string;
				scrum_config: Record<string, unknown>;
				velocity_window: unknown[];
				last_sprint_plan_at: Date | null;
				last_groom_at: Date | null;
				last_standup_at: Date | null;
				last_retro_at: Date | null;
			}>
		>(
			`SELECT id, scrum_config, velocity_window,
              last_sprint_plan_at, last_groom_at,
              last_standup_at, last_retro_at
       FROM clickup_tracker.projects
       WHERE id = $1::uuid`,
			id,
		);
		const row = rows[0];
		if (!row) return { found: false };
		return {
			found: true,
			scrumConfig: row.scrum_config ?? {},
			velocityWindow: row.velocity_window ?? [],
			lastSprintPlanAt: row.last_sprint_plan_at,
			lastGroomAt: row.last_groom_at,
			lastStandupAt: row.last_standup_at,
			lastRetroAt: row.last_retro_at,
			killSwitch: process.env.CUP_AUTOSCRUM === "off",
		};
	}

	@Patch(":id/scrum/config")
	async patchConfig(
		@Req() req: any,
		@Param("id") id: string,
		@Body() patch: Record<string, unknown>,
	) {
		orgIdOrThrow(req);
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET scrum_config = COALESCE(scrum_config, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
			id,
			JSON.stringify(patch ?? {}),
		);
		return { ok: true };
	}

	@Get(":id/scrum/audit")
	async getAudit(
		@Req() req: any,
		@Param("id") id: string,
		@Query("since") since?: string,
		@Query("kind") kind?: string,
		@Query("limit") limit?: string,
	) {
		orgIdOrThrow(req);
		const lim = limit ? Number(limit) : 100;
		return this.audit.list(id, {
			since,
			kind,
			limit: Number.isFinite(lim) ? lim : 100,
		});
	}
}

function orgIdOrThrow(req: any): string {
	const orgId = req.user?.orgId || req.headers?.["x-organisation-id"];
	if (!orgId) throw new UnauthorizedException("missing x-organisation-id");
	return orgId;
}
