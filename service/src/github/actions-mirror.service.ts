import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §M.2 — GitHub Actions status mirror + PR lifecycle on commit tasks.
 *
 *   recordRun        — workflow_run.completed → tag commit task with
 *                      ✅/❌/⏸ + post a comment with the run URL
 *   recordPrOpened   — pull_request.opened → tag commit task `pr-open`
 *                      + comment with PR URL
 *   recordPrClosed   — pull_request.closed (merged or not) → tag the
 *                      merge_commit_sha task `pr-merged` (or `pr-closed`)
 *
 * Each method is best-effort; per-call failures debug-logged so a flaky
 * Action run never blocks the webhook idempotency row.
 */
@Injectable()
export class ActionsMirrorService {
	private readonly log = new Logger(ActionsMirrorService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async recordRun(input: {
		projectId: string;
		commitSha: string;
		conclusion: string; // success / failure / cancelled / skipped / timed_out
		htmlUrl: string | null;
		runId: string;
		name: string;
	}): Promise<void> {
		const project = await this.loadProject(input.projectId);
		if (!project) return;
		const taskId = project.task_index?.[`commit:${input.commitSha}`];
		if (!taskId) return;
		const tag = ciTagFor(input.conclusion);
		try {
			const creds = await this.credentials.forOrg(project.organisation_id);
			if (tag) {
				await this.clickup.addTagToTask(taskId, tag, creds.token);
			}
			const lines: string[] = [];
			lines.push(`**CI:** ${input.name || "workflow"} → ${input.conclusion}`);
			if (input.htmlUrl) lines.push(`<${input.htmlUrl}>`);
			await this.clickup.addComment(taskId, lines.join("\n"), creds.token);
		} catch (err) {
			this.log.debug(
				`actions-mirror recordRun(${input.runId}) failed: ${(err as Error).message}`,
			);
		}
	}

	async recordPrOpened(input: {
		projectId: string;
		prNumber: number;
		htmlUrl: string | null;
		headSha: string | null;
	}): Promise<void> {
		const project = await this.loadProject(input.projectId);
		if (!project || !input.headSha) return;
		const taskId = project.task_index?.[`commit:${input.headSha}`];
		if (!taskId) return;
		try {
			const creds = await this.credentials.forOrg(project.organisation_id);
			await this.clickup.addTagToTask(taskId, "pr-open", creds.token);
			if (input.htmlUrl) {
				await this.clickup.addComment(
					taskId,
					`**PR opened:** <${input.htmlUrl}>`,
					creds.token,
				);
			}
		} catch (err) {
			this.log.debug(
				`actions-mirror recordPrOpened(${input.prNumber}) failed: ${(err as Error).message}`,
			);
		}
	}

	async recordPrClosed(input: {
		projectId: string;
		prNumber: number;
		merged: boolean;
		mergeCommitSha: string | null;
	}): Promise<void> {
		const project = await this.loadProject(input.projectId);
		if (!project) return;
		const sha = input.mergeCommitSha;
		if (!sha) return;
		const taskId = project.task_index?.[`commit:${sha}`];
		if (!taskId) return;
		try {
			const creds = await this.credentials.forOrg(project.organisation_id);
			const tag = input.merged ? "pr-merged" : "pr-closed";
			await this.clickup.addTagToTask(taskId, tag, creds.token);
		} catch (err) {
			this.log.debug(
				`actions-mirror recordPrClosed(${input.prNumber}) failed: ${(err as Error).message}`,
			);
		}
	}

	private async loadProject(projectId: string): Promise<{
		id: string;
		organisation_id: string;
		task_index: Record<string, string> | null;
	} | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{
					id: string;
					organisation_id: string;
					task_index: Record<string, string> | null;
				}>
			>(
				`SELECT id, organisation_id, task_index
				 FROM clickup_tracker.projects
				 WHERE id = $1::uuid`,
				projectId,
			);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}
}

export function ciTagFor(conclusion: string): string | null {
	switch (conclusion) {
		case "success":
			return "ci-pass";
		case "failure":
		case "timed_out":
			return "ci-fail";
		case "cancelled":
			return "ci-cancelled";
		default:
			return null;
	}
}
