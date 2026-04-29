import {
	Body,
	Controller,
	Get,
	Logger,
	NotFoundException,
	Param,
	Post,
	Req,
	UnauthorizedException,
} from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { BackfillService } from "./backfill.service";

interface ApproveDto {
	note?: string;
}
interface ReopenDto {
	note?: string;
}
interface AssignDto {
	email: string;
}
interface CommentDto {
	markdown: string;
}

/**
 * Control endpoints layered on top of the backfill orchestrator and the
 * ClickUp direct service. All routes share the existing org-id guard
 * (header-based) used by ProjectsController.
 */
@Controller("projects/:projectId")
export class BackfillController {
	private readonly log = new Logger(BackfillController.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
		private readonly backfill: BackfillService,
	) {}

	@Get("backfill")
	async status(@Req() req: any, @Param("projectId") projectId: string) {
		await this.assertProject(req, projectId);
		const state = await this.backfill.getState(projectId);
		if (!state) throw new NotFoundException("project has no backfill state");
		return state;
	}

	@Post("replan")
	async replan(@Req() req: any, @Param("projectId") projectId: string) {
		await this.assertProject(req, projectId);
		const jobId = await this.backfill.enqueue(projectId);
		return { ok: true, jobId };
	}

	/**
	 * Flip template_status after the user has manually upgraded the workspace
	 * via the UI walkthrough at docs/clickup-template/README.md (set the 7-status
	 * cascade on the Space + 6-status override on the Bugs List). Once flipped,
	 * the lifecycle handler stops mapping to "to do"/"complete" and uses the
	 * literal 7-status names.
	 */
	@Post("template-configured")
	async markTemplateConfigured(
		@Req() req: any,
		@Param("projectId") projectId: string,
	) {
		await this.assertProject(req, projectId);
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET template_status = 'configured', updated_at = NOW()
       WHERE id = $1::uuid`,
			projectId,
		);
		return { ok: true, template_status: "configured" };
	}

	@Post("tasks/:taskId/approve")
	async approveTask(
		@Req() req: any,
		@Param("projectId") projectId: string,
		@Param("taskId") taskId: string,
		@Body() dto: ApproveDto = {},
	) {
		const project = await this.assertProject(req, projectId);
		const creds = await this.credentials.forOrg(project.organisation_id);
		if (dto.note) {
			await this.clickup.addComment(taskId, dto.note, creds.token);
		}
		const status =
			project.template_status === "configured" ? "Done" : "complete";
		await this.clickup.setTaskStatus(taskId, status, creds.token);
		return { ok: true, status };
	}

	@Post("tasks/:taskId/reopen")
	async reopenTask(
		@Req() req: any,
		@Param("projectId") projectId: string,
		@Param("taskId") taskId: string,
		@Body() dto: ReopenDto = {},
	) {
		const project = await this.assertProject(req, projectId);
		const creds = await this.credentials.forOrg(project.organisation_id);
		if (dto.note) {
			await this.clickup.addComment(taskId, dto.note, creds.token);
		}
		const status =
			project.template_status === "configured" ? "In Progress" : "to do";
		await this.clickup.setTaskStatus(taskId, status, creds.token);
		return { ok: true, status };
	}

	@Post("tasks/:taskId/assign")
	async assignTask(
		@Req() req: any,
		@Param("projectId") projectId: string,
		@Param("taskId") taskId: string,
		@Body() dto: AssignDto,
	) {
		const project = await this.assertProject(req, projectId);
		if (!dto.email) {
			throw new NotFoundException("email required in body");
		}
		const creds = await this.credentials.forOrg(project.organisation_id);
		const settings = await this.prisma.$queryRawUnsafe<
			Array<{ members_cache: Record<string, number> }>
		>(
			`SELECT members_cache FROM clickup_tracker.workspace_settings
       WHERE clickup_team_id = $1`,
			creds.team_id,
		);
		const cache = settings[0]?.members_cache ?? {};
		const userId = cache[dto.email.toLowerCase()];
		if (!userId) {
			return { ok: false, reason: "email_not_in_workspace" };
		}
		await this.clickup.assignTask(taskId, [userId], [], creds.token);
		return { ok: true, assignedUserId: userId };
	}

	@Post("tasks/:taskId/comment")
	async commentTask(
		@Req() req: any,
		@Param("projectId") projectId: string,
		@Param("taskId") taskId: string,
		@Body() dto: CommentDto,
	) {
		const project = await this.assertProject(req, projectId);
		const creds = await this.credentials.forOrg(project.organisation_id);
		await this.clickup.addComment(taskId, dto.markdown, creds.token);
		return { ok: true };
	}

	private async assertProject(
		req: any,
		projectId: string,
	): Promise<{
		id: string;
		organisation_id: string;
		template_status: string | null;
	}> {
		const orgId = req.user?.orgId || req.headers?.["x-organisation-id"];
		if (!orgId) throw new UnauthorizedException("missing x-organisation-id");
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{
				id: string;
				organisation_id: string;
				template_status: string | null;
			}>
		>(
			`SELECT id, organisation_id, template_status
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND organisation_id = $2::uuid`,
			projectId,
			orgId,
		);
		if (rows.length === 0) throw new NotFoundException("project not found");
		return rows[0];
	}
}
