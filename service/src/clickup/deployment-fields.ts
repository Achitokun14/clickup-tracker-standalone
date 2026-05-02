import type { ClickUpDirectService } from "./clickup-direct.service";

/**
 * Plan §N.6 — custom fields on the 🚀 Deployments List.
 *
 *   environment           drop_down   production / staging / preview
 *   deployment_status     drop_down   the 7 Railway statuses
 *   commit_sha            short_text  bound to the shipped commit
 *   build_duration_seconds number     elapsed time in seconds
 *   deploy_url            url         Railway-served public URL (when present)
 *
 * Idempotent: skip any field whose name already exists on the List.
 */
export const DEPLOYMENT_FIELD_KEYS = [
	"environment",
	"deployment_status",
	"commit_sha",
	"build_duration_seconds",
	"deploy_url",
] as const;
export type DeploymentFieldKey = (typeof DEPLOYMENT_FIELD_KEYS)[number];

export const DEPLOYMENT_STATUS_OPTIONS = [
	"BUILDING",
	"DEPLOYING",
	"SUCCESS",
	"FAILED",
	"CANCELLED",
	"REMOVED",
	"QUEUED",
] as const;

export const DEPLOYMENT_ENV_OPTIONS = [
	"production",
	"staging",
	"preview",
] as const;

export interface DeploymentFieldSeedResult {
	created: DeploymentFieldKey[];
	existing: DeploymentFieldKey[];
	ids: Record<DeploymentFieldKey, string>;
}

export async function seedDeploymentFields(
	clickup: Pick<
		ClickUpDirectService,
		"getListCustomFields" | "createCustomField"
	>,
	listId: string,
	token: string,
): Promise<DeploymentFieldSeedResult> {
	const existing = await clickup.getListCustomFields(listId, token);
	const byName = new Map(existing.map((f) => [f.name, f.id]));

	const result: DeploymentFieldSeedResult = {
		created: [],
		existing: [],
		ids: {} as Record<DeploymentFieldKey, string>,
	};

	for (const key of DEPLOYMENT_FIELD_KEYS) {
		const found = byName.get(key);
		if (found) {
			result.existing.push(key);
			result.ids[key] = found;
			continue;
		}
		const body = buildFieldBody(key);
		const r = await clickup.createCustomField(listId, body, token);
		result.created.push(key);
		result.ids[key] = r.id;
	}
	return result;
}

function buildFieldBody(
	key: DeploymentFieldKey,
): Parameters<ClickUpDirectService["createCustomField"]>[1] {
	switch (key) {
		case "environment":
			return {
				name: "environment",
				type: "drop_down",
				type_config: {
					options: DEPLOYMENT_ENV_OPTIONS.map((name, i) => ({
						name,
						orderindex: i,
					})),
				},
			};
		case "deployment_status":
			return {
				name: "deployment_status",
				type: "drop_down",
				type_config: {
					options: DEPLOYMENT_STATUS_OPTIONS.map((name, i) => ({
						name,
						orderindex: i,
					})),
				},
			};
		case "commit_sha":
			return { name: "commit_sha", type: "short_text" };
		case "build_duration_seconds":
			return { name: "build_duration_seconds", type: "number" };
		case "deploy_url":
			return { name: "deploy_url", type: "url" };
	}
}
