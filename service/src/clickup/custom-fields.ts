import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpDirectService } from "./clickup-direct.service";

/**
 * Canonical custom-field schema for v0.4.0 Spaces. Field names are
 * intentionally short — they appear in the CU UI sidebar.
 *
 * Field-key → (type, dropdown options if any). The same key is also the CU
 * field name that we look up by; idempotent re-seed checks `getListCustomFields`
 * before attempting `createCustomField`.
 */
export type FieldKey =
	| "commit_sha"
	| "pr_url"
	| "author_email"
	| "author_github_url"
	| "epic"
	| "severity"
	| "source"
	| "milestone";

export type ListKey =
	| "active_sprint"
	| "in_review"
	| "open_work"
	| "bugs"
	| "history_overview"
	| "adrs"
	| "agent_sessions";

export interface FieldSpec {
	name: string;
	type:
		| "short_text"
		| "text"
		| "url"
		| "email"
		| "drop_down"
		| "users"
		| "number";
	options?: Array<{ name: string; color?: string }>;
}

export const FIELD_SPECS: Record<FieldKey, FieldSpec> = {
	commit_sha: { name: "commit_sha", type: "short_text" },
	pr_url: { name: "pr_url", type: "url" },
	author_email: { name: "author_email", type: "email" },
	author_github_url: { name: "author_github_url", type: "url" },
	epic: {
		name: "epic",
		type: "drop_down",
		options: [
			{ name: "epic:api-backend", color: "#3B82F6" },
			{ name: "epic:auth-security", color: "#7C3AED" },
			{ name: "epic:scrum", color: "#10B981" },
			{ name: "epic:dependencies", color: "#A16207" },
			{ name: "epic:docs", color: "#0EA5E9" },
			{ name: "epic:infra", color: "#0F766E" },
			{ name: "epic:tests", color: "#F59E0B" },
			{ name: "epic:other", color: "#6B7280" },
		],
	},
	severity: {
		name: "severity",
		type: "drop_down",
		options: [
			{ name: "critical", color: "#DC2626" },
			{ name: "high", color: "#EA580C" },
			{ name: "medium", color: "#FBBF24" },
			{ name: "low", color: "#10B981" },
		],
	},
	source: {
		name: "source",
		type: "drop_down",
		options: [
			{ name: "commit", color: "#6B7280" },
			{ name: "pr", color: "#3B82F6" },
			{ name: "agent", color: "#8B5CF6" },
			{ name: "manual", color: "#475569" },
			{ name: "hotspot", color: "#F43F5E" },
			{ name: "dep", color: "#A16207" },
			{ name: "form", color: "#10B981" },
			{ name: "deployment", color: "#0EA5E9" },
		],
	},
	milestone: {
		name: "milestone",
		type: "drop_down",
		options: [{ name: "tbd", color: "#6B7280" }],
	},
};

/**
 * Which keys belong on which List. Lists not listed here get no fields.
 * Sprint history Lists hydrate via the same set as `active_sprint` — keyed
 * dynamically in seedFieldsForSprintList.
 */
export const FIELDS_PER_LIST: Record<ListKey, FieldKey[]> = {
	active_sprint: [
		"commit_sha",
		"pr_url",
		"author_email",
		"author_github_url",
		"epic",
		"source",
	],
	in_review: [
		"commit_sha",
		"pr_url",
		"author_email",
		"author_github_url",
		"source",
	],
	open_work: [
		"author_email",
		"author_github_url",
		"epic",
		"milestone",
		"source",
	],
	bugs: ["author_email", "author_github_url", "severity", "epic", "source"],
	history_overview: [],
	adrs: ["author_email", "author_github_url"],
	agent_sessions: ["author_email", "source"],
};

@Injectable()
export class CustomFieldsService {
	private readonly log = new Logger(CustomFieldsService.name);

	constructor(
		private readonly clickup: ClickUpDirectService,
		private readonly prisma: PrismaService,
	) {}

	/**
	 * Idempotent: reads existing fields, creates only missing ones, returns
	 * `{ key → fieldId }` map of every field for this List (existing + new).
	 */
	async seedFieldsForList(
		listId: string,
		listKey: ListKey,
		token: string,
	): Promise<Record<string, string>> {
		const wanted = FIELDS_PER_LIST[listKey] ?? [];
		if (wanted.length === 0) return {};
		let existing: Array<{ id: string; name?: string }> = [];
		try {
			existing = await this.clickup.getListCustomFields(listId, token);
		} catch (err) {
			this.log.warn(
				`getListCustomFields(${listId}) failed: ${(err as Error).message}`,
			);
			return {};
		}
		const byName = new Map<string, string>();
		for (const f of existing) {
			if (f.name) byName.set(f.name.toLowerCase(), f.id);
		}
		const out: Record<string, string> = {};
		for (const key of wanted) {
			const spec = FIELD_SPECS[key];
			const lower = spec.name.toLowerCase();
			const found = byName.get(lower);
			if (found) {
				out[key] = found;
				continue;
			}
			try {
				const created = await this.clickup.createCustomField(
					listId,
					{
						name: spec.name,
						type: spec.type,
						type_config: spec.options
							? {
									options: spec.options.map((o, i) => ({
										name: o.name,
										color: o.color,
										orderindex: i,
									})),
								}
							: undefined,
					},
					token,
				);
				out[key] = created.id;
			} catch (err) {
				this.log.warn(
					`createCustomField(${spec.name}) on list ${listId} failed: ` +
						`${(err as Error).message}`,
				);
			}
		}
		return out;
	}

	/**
	 * Persist `key → fieldId` map onto the project row, scoped per list:
	 * `custom_field_ids[listKey][fieldKey] = fieldId`.
	 */
	async persistFieldIds(
		projectId: string,
		listKey: ListKey,
		fieldIds: Record<string, string>,
	): Promise<void> {
		if (Object.keys(fieldIds).length === 0) return;
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
			 SET custom_field_ids = jsonb_set(
			   COALESCE(custom_field_ids, '{}'::jsonb),
			   $2::text[],
			   $3::jsonb,
			   true
			 ),
			 updated_at = NOW()
			 WHERE id = $1::uuid`,
			projectId,
			`{${listKey}}`,
			JSON.stringify(fieldIds),
		);
	}

	/**
	 * Apply a batch of field values to a single task. Skips entries where the
	 * project has no recorded field id for that key (i.e. v0.3.x project that
	 * pre-dates field seeding). Errors per field are logged but non-fatal.
	 */
	async setFieldsOnTask(
		taskId: string,
		fieldIdsForList: Record<string, string> | undefined,
		values: Partial<Record<FieldKey, unknown>>,
		token: string,
	): Promise<void> {
		if (!fieldIdsForList) return;
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined || value === null || value === "") continue;
			const fieldId = fieldIdsForList[key];
			if (!fieldId) continue;
			try {
				await this.clickup.setCustomFieldValue(taskId, fieldId, value, token);
			} catch (err) {
				this.log.debug(
					`setCustomFieldValue(${key}) on task ${taskId} failed: ` +
						`${(err as Error).message}`,
				);
			}
		}
	}
}
