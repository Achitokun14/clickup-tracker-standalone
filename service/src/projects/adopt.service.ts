import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { isoWeekOf } from "../util/iso-week";
import type { ProjectRow } from "./projects.service";

/**
 * Plan §B.2 + §B.3 — explicit adoption of an existing ClickUp Space.
 *
 * The implicit adoption already running inside `BackfillService.ensureSpace`
 * matches Spaces by name and persists the space_id, but it then proceeds to
 * call createFolder/createListInFolder/createTask for every artefact —
 * which produces duplicates when those Folders/Lists/Tasks already exist
 * in the matched Space. Explicit adoption is the alternative path: the
 * operator (or peer-developer onboarding) calls POST /projects/adopt with
 * an explicit spaceId, we hydrate `list_ids`, `sprint_lists`, `task_index`
 * from the existing Space's contents, and we mark the project as
 * "alreadyTracked" so the backfill orchestrator's createTask loop only
 * fires for genuinely-new tasks.
 *
 * Hydration is *tolerant*: Folders are matched by their leading emoji
 * (📦 🚧 📜 📚), Lists by case-insensitive name with whitespace
 * normalisation. Anything we don't recognise is captured in
 * `extra_lists` / `extra_folders` so the daemon never touches it.
 *
 * Tasks are claimed only when their description contains the
 * `_Auto-imported by clickup-tracker._` footer — manual tasks created by
 * humans are left alone, even if their name happens to match the
 * `[YYYY-MM-DD] type(scope): subject` pattern.
 */

export interface AdoptDto {
	localPath: string;
	displayName: string;
	clickupSpaceId: string;
	gitRemoteUrl?: string;
	scopeMode?: string;
	scopePaths?: string[];
}

export interface AdoptResult {
	projectId: string;
	spaceId: string;
	spaceUrl: string;
	folderId: string;
	folderUrl: string;
	listIds: Record<string, string>;
	sprintLists: Record<string, string>;
	clickupDocId: string | null;
	extraLists: Array<{ folderId: string; listId: string; name: string }>;
	extraFolders: Array<{ folderId: string; name: string }>;
	taskIndexCount: number;
	hookSecret: string;
	adopted: true;
	alreadyTracked: false;
}

const FOLDER_EMOJI_MAP: Record<string, string> = {
	"📦": "backlog_bugs",
	"🚧": "active_work",
	"📜": "history",
	"📚": "knowledge",
};

const FOOTER_RX = /_Auto-imported by clickup-tracker\._/;
const COMMIT_NAME_RX = /^\[(\d{4}-\d{2}-\d{2})\] (\w+)\((.*?)\): (.+)$/;
const SPRINT_LIST_NAME_RX =
	/Sprint\s+\d+\s+[—–-]\s+(\d{4}-\d{2}-\d{2})\s*[→→\->]+\s*(\d{4}-\d{2}-\d{2})/;
const SHA_FOOTER_RX = /\b([a-f0-9]{7,40})\b/;

@Injectable()
export class AdoptService {
	private readonly log = new Logger(AdoptService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async adopt(orgId: string, dto: AdoptDto): Promise<AdoptResult> {
		if (!dto.clickupSpaceId) {
			throw new BadRequestException("clickupSpaceId is required");
		}
		const creds = await this.credentials.forOrg(orgId);

		// Verify the Space exists and is reachable with these credentials.
		const spaces = await this.clickup.listSpaces(creds.team_id, creds.token);
		const space = spaces.find((s) => s.id === dto.clickupSpaceId);
		if (!space) {
			throw new NotFoundException(
				`Space ${dto.clickupSpaceId} not found in workspace ${creds.team_id}`,
			);
		}

		// 1. Folders — bucket by leading emoji.
		const folders = await this.clickup.listFolders(space.id, creds.token);
		const foldersByKey: Record<string, { id: string; name: string }> = {};
		const extraFolders: Array<{ folderId: string; name: string }> = [];
		for (const f of folders) {
			const name = f.name ?? "";
			const key = matchFolderKey(name);
			if (key) foldersByKey[key] = { id: f.id, name };
			else extraFolders.push({ folderId: f.id, name });
		}

		// 2. Lists — tolerant per-folder name match.
		const listIds: Record<string, string> = {};
		const sprintLists: Record<string, string> = {};
		const extraLists: Array<{
			folderId: string;
			listId: string;
			name: string;
		}> = [];
		for (const [folderKey, folder] of Object.entries(foldersByKey)) {
			const lists = await this.clickup.listListsInFolder(
				folder.id,
				creds.token,
			);
			for (const l of lists) {
				if (folderKey === "history") {
					const sprintKey = parseSprintIsoWeek(l.name ?? "");
					if (sprintKey) {
						sprintLists[sprintKey] = l.id;
						continue;
					}
				}
				const listKey = matchListKey(folderKey, l.name ?? "");
				if (listKey) listIds[listKey] = l.id;
				else
					extraLists.push({
						folderId: folder.id,
						listId: l.id,
						name: l.name ?? "",
					});
			}
		}

		// 3. task_index — claim only auto-imported tasks (footer regex).
		const taskIndex: Record<string, string> = {};
		for (const [listKey, listId] of Object.entries(listIds)) {
			let tasks: Array<{
				id: string;
				name: string;
				markdown_description?: string;
				description?: string;
			}>;
			try {
				tasks = (await this.clickup.listTasksInList(
					listId,
					creds.token,
				)) as any;
			} catch (err) {
				this.log.warn(
					`listTasksInList(${listId}, key=${listKey}) failed during adopt: ${(err as Error).message}`,
				);
				continue;
			}
			for (const t of tasks) {
				const desc = t.markdown_description ?? t.description ?? "";
				if (!FOOTER_RX.test(desc)) continue;
				const sha = parseShaFromDescription(desc);
				const m = COMMIT_NAME_RX.exec(t.name ?? "");
				if (m && sha) {
					taskIndex[`commit:${sha}`] = t.id;
				}
			}
		}

		// 4. Persist a project row marked status='active' with hydrated state.
		const hookSecret = randomBytes(32).toString("hex");
		await this.prisma.$executeRawUnsafe(
			`DELETE FROM clickup_tracker.projects
       WHERE organisation_id = $1::uuid AND local_path = $2 AND status = 'removed'`,
			orgId,
			dto.localPath,
		);
		const inserted = await this.prisma.$queryRawUnsafe<ProjectRow[]>(
			`INSERT INTO clickup_tracker.projects (
        organisation_id, local_path, display_name, git_remote_url, scope_config,
        clickup_team_id, clickup_space_id, clickup_folder_id, list_ids,
        sprint_lists, custom_field_ids, task_index, hook_secret, status,
        last_synced_at, backfill_state, extra_lists, extra_folders
      )
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb,
              $10::jsonb, $11::jsonb, $12::jsonb, $13, 'active', NOW(),
              $14::jsonb, $15::jsonb, $16::jsonb)
      RETURNING *`,
			orgId,
			dto.localPath,
			dto.displayName,
			dto.gitRemoteUrl ?? null,
			JSON.stringify({
				mode: dto.scopeMode ?? "root",
				paths: dto.scopePaths ?? [],
			}),
			creds.team_id,
			space.id,
			foldersByKey.active_work?.id ?? "",
			JSON.stringify(listIds),
			JSON.stringify(sprintLists),
			JSON.stringify({}),
			JSON.stringify(taskIndex),
			hookSecret,
			JSON.stringify({ status: "adopted", at: new Date().toISOString() }),
			JSON.stringify(extraLists),
			JSON.stringify(extraFolders),
		);
		const row = inserted[0];

		this.log.log(
			`adopted Space ${space.id} as project ${row.id} (${dto.displayName}): ` +
				`${Object.keys(listIds).length} lists, ` +
				`${Object.keys(sprintLists).length} sprints, ` +
				`${Object.keys(taskIndex).length} tasks claimed`,
		);

		return {
			projectId: row.id,
			spaceId: space.id,
			spaceUrl: `https://app.clickup.com/${creds.team_id}/v/s/${space.id}`,
			folderId: foldersByKey.active_work?.id ?? "",
			folderUrl: foldersByKey.active_work?.id
				? `https://app.clickup.com/${creds.team_id}/v/f/${foldersByKey.active_work.id}`
				: "",
			listIds,
			sprintLists,
			clickupDocId: null,
			extraLists,
			extraFolders,
			taskIndexCount: Object.keys(taskIndex).length,
			hookSecret,
			adopted: true,
			alreadyTracked: false,
		};
	}
}

// ── helpers ───────────────────────────────────────────────────────────

export function matchFolderKey(folderName: string): string | null {
	const trimmed = folderName.trim();
	for (const [emoji, key] of Object.entries(FOLDER_EMOJI_MAP)) {
		if (trimmed.startsWith(emoji)) return key;
	}
	return null;
}

export function matchListKey(
	folderKey: string,
	listName: string,
): string | null {
	const n = listName.trim().toLowerCase();
	switch (folderKey) {
		case "backlog_bugs":
			if (n === "open work") return "open_work";
			if (n === "bugs") return "bugs";
			break;
		case "active_work":
			if (n === "active sprint") return "active_sprint";
			if (n === "in review") return "in_review";
			break;
		case "knowledge":
			if (n === "adrs") return "adrs";
			if (n === "agent sessions") return "agent_sessions";
			break;
	}
	return null;
}

export function parseSprintIsoWeek(listName: string): string | null {
	const m = SPRINT_LIST_NAME_RX.exec(listName);
	if (!m) return null;
	// Use the start date to compute the ISO week key.
	const start = new Date(m[1] + "T00:00:00Z");
	if (Number.isNaN(start.getTime())) return null;
	return isoWeekOf(start).key;
}

function parseShaFromDescription(desc: string): string | null {
	// Look for the first 7-40 char hex run (commit SHA in the description).
	// Adoption is best-effort — we accept whatever the original daemon emitted.
	const m = SHA_FOOTER_RX.exec(desc);
	return m ? m[1] : null;
}
