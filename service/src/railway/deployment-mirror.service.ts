import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import {
	DEPLOYMENT_FIELD_KEYS,
	type DeploymentFieldKey,
} from "../clickup/deployment-fields";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import {
	statusEmoji,
	terminalStatus,
	type RailwayDeployment,
} from "./railway.service";

/**
 * Plan §N.3 / §N.4 / §N.5 — mirror a Railway deployment as a CU task in
 * the project's 🚀 Deployments List, persist its state in
 * `clickup_tracker.railway_deployments`, and (when the deploy ships
 * known commits) cross-link the commit tasks via `addTaskLink` plus a
 * `deployed_to_<env>` tag.
 *
 * `mirror()` is idempotent: same Railway deployment id → same CU task,
 * with status / custom-fields refreshed in place.
 */

interface ProjectRowSlim {
	id: string;
	organisation_id: string;
	deployments_list_id: string | null;
	custom_field_ids: Record<string, string> | null;
	task_index: Record<string, string> | null;
}

export interface MirrorResult {
	taskId: string | null;
	created: boolean;
	updated: boolean;
	skippedReason?: "no_list" | "no_creds";
}

@Injectable()
export class DeploymentMirrorService {
	private readonly log = new Logger(DeploymentMirrorService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async mirror(
		projectId: string,
		dep: RailwayDeployment,
	): Promise<MirrorResult> {
		const project = await this.loadProject(projectId);
		if (!project) return { taskId: null, created: false, updated: false };
		if (!project.deployments_list_id) {
			return {
				taskId: null,
				created: false,
				updated: false,
				skippedReason: "no_list",
			};
		}

		const cached = await this.cachedRow(dep.id);
		const existingTaskId = cached?.cu_task_id ?? null;

		let creds;
		try {
			creds = await this.credentials.forOrg(project.organisation_id);
		} catch {
			return {
				taskId: existingTaskId,
				created: false,
				updated: false,
				skippedReason: "no_creds",
			};
		}

		const env = dep.environmentName ?? "unknown";
		const shaShort = dep.commitSha?.slice(0, 7) ?? "no-commit";
		const name = `🚀 [${env}] ${shaShort} · ${statusEmoji(dep.status)} ${dep.status}`;
		const description = renderDeploymentBody(dep);

		let taskId = existingTaskId;
		let created = false;
		let updated = false;
		try {
			if (!taskId) {
				const t = await this.clickup.createTask(
					project.deployments_list_id,
					{ name, markdown_content: description },
					creds.token,
				);
				taskId = t.id;
				created = true;
			} else {
				await this.clickup.updateTask(
					taskId,
					{ name, markdown_content: description },
					creds.token,
				);
				updated = true;
			}
		} catch (err) {
			this.log.debug(
				`mirror(${dep.id}) task upsert failed: ${(err as Error).message}`,
			);
		}

		if (taskId) {
			await this.applyCustomFields(taskId, dep, project, creds.token);
			if (terminalStatus(dep.status)) {
				await this.crossLinkCommitTask(taskId, dep, project, creds.token, env);
			}
		}

		await this.persistRow(projectId, dep, taskId);
		return { taskId, created, updated };
	}

	private async applyCustomFields(
		taskId: string,
		dep: RailwayDeployment,
		project: ProjectRowSlim,
		token: string,
	): Promise<void> {
		const ids = project.custom_field_ids ?? {};
		const values: Record<DeploymentFieldKey, unknown> = {
			environment: dep.environmentName ?? "preview",
			deployment_status: dep.status,
			commit_sha: dep.commitSha ?? "",
			build_duration_seconds: durationSeconds(dep) ?? 0,
			deploy_url: dep.staticUrl ?? "",
		};
		for (const key of DEPLOYMENT_FIELD_KEYS) {
			const fieldId = ids[key];
			if (!fieldId) continue;
			const v = values[key];
			if (v === "" || v === null || v === undefined) continue;
			try {
				await this.clickup.setCustomFieldValue(taskId, fieldId, v, token);
			} catch (err) {
				this.log.debug(
					`mirror(${dep.id}) field ${key} write failed: ${(err as Error).message}`,
				);
			}
		}
	}

	private async crossLinkCommitTask(
		deployTaskId: string,
		dep: RailwayDeployment,
		project: ProjectRowSlim,
		token: string,
		env: string,
	): Promise<void> {
		if (!dep.commitSha) return;
		const commitTaskId = project.task_index?.[`commit:${dep.commitSha}`];
		if (!commitTaskId) return;
		const tag = `deployed-to-${env}`.toLowerCase();
		try {
			await this.clickup.addTaskLink(deployTaskId, commitTaskId, token);
		} catch (err) {
			this.log.debug(
				`mirror(${dep.id}) addTaskLink failed: ${(err as Error).message}`,
			);
		}
		try {
			await this.clickup.addTagToTask(commitTaskId, tag, token);
		} catch (err) {
			this.log.debug(
				`mirror(${dep.id}) addTagToTask(${tag}) failed: ${(err as Error).message}`,
			);
		}
	}

	private async cachedRow(
		deploymentId: string,
	): Promise<{ cu_task_id: string | null; status: string } | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<
				Array<{ cu_task_id: string | null; status: string }>
			>(
				`SELECT cu_task_id, status FROM clickup_tracker.railway_deployments
				 WHERE id = $1`,
				deploymentId,
			);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}

	private async persistRow(
		projectId: string,
		dep: RailwayDeployment,
		cuTaskId: string | null,
	): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`INSERT INTO clickup_tracker.railway_deployments
				   (id, project_id, service_id, environment, commit_sha, status,
				    started_at, finished_at, cu_task_id, raw, updated_at)
				 VALUES ($1, $2::uuid, $3, $4, $5, $6,
				         $7::timestamptz, $8::timestamptz, $9, $10::jsonb, NOW())
				 ON CONFLICT (id) DO UPDATE SET
				   status       = EXCLUDED.status,
				   commit_sha   = COALESCE(EXCLUDED.commit_sha, railway_deployments.commit_sha),
				   environment  = EXCLUDED.environment,
				   finished_at  = COALESCE(EXCLUDED.finished_at, railway_deployments.finished_at),
				   cu_task_id   = COALESCE(EXCLUDED.cu_task_id, railway_deployments.cu_task_id),
				   raw          = EXCLUDED.raw,
				   updated_at   = NOW()`,
				dep.id,
				projectId,
				dep.serviceId,
				dep.environmentName ?? "unknown",
				dep.commitSha,
				dep.status,
				dep.createdAt,
				dep.finishedAt,
				cuTaskId,
				JSON.stringify(dep),
			);
		} catch (err) {
			this.log.debug(`persistRow(${dep.id}) failed: ${(err as Error).message}`);
		}
	}

	private async loadProject(projectId: string): Promise<ProjectRowSlim | null> {
		try {
			const rows = await this.prisma.$queryRawUnsafe<ProjectRowSlim[]>(
				`SELECT id, organisation_id, deployments_list_id,
				        custom_field_ids, task_index
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

export function durationSeconds(dep: RailwayDeployment): number | null {
	if (!dep.createdAt || !dep.finishedAt) return null;
	const start = Date.parse(dep.createdAt);
	const end = Date.parse(dep.finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
		return null;
	return Math.round((end - start) / 1000);
}

export function renderDeploymentBody(dep: RailwayDeployment): string {
	const lines: string[] = [];
	lines.push(`> **Service:** \`${dep.serviceId}\``);
	if (dep.environmentName)
		lines.push(`> **Environment:** ${dep.environmentName}`);
	if (dep.commitSha) lines.push(`> **Commit:** \`${dep.commitSha}\``);
	if (dep.createdAt) lines.push(`> **Started:** ${dep.createdAt}`);
	if (dep.finishedAt) lines.push(`> **Finished:** ${dep.finishedAt}`);
	const dur = durationSeconds(dep);
	if (dur !== null) lines.push(`> **Duration:** ${dur}s`);
	if (dep.staticUrl) lines.push(`> **URL:** <${dep.staticUrl}>`);
	lines.push("");
	lines.push(`Status: **${statusEmoji(dep.status)} ${dep.status}**`);
	lines.push("");
	lines.push("---");
	lines.push("_Auto-imported by clickup-tracker (Railway)._");
	return lines.join("\n");
}
