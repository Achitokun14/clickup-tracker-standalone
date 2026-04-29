import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
	ClickUpDirectService,
	ClickUpTaskFull,
} from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";

export type BackupTrigger = "manual" | "pre_revert" | "pre_remove" | "periodic";
export type RestoreMode = "additive" | "merge" | "replace";

export interface SnapshotTask {
	id: string;
	list_id: string;
	list_key: string;
	task_key: string;
	name: string;
	markdown_description: string;
	status: string;
}

export interface BackupSnapshot {
	schema_version: 1;
	taken_at: string;
	folder: { id: string; name: string };
	lists: Array<{ id: string; key: string; name: string }>;
	tasks: SnapshotTask[];
}

export interface BackupRecord {
	id: string;
	project_id: string;
	trigger: BackupTrigger;
	taken_at: Date;
	task_count: number;
	list_count: number;
}

interface ProjectForBackup {
	id: string;
	organisation_id: string;
	display_name: string;
	clickup_folder_id: string;
	list_ids: { overview: string; open_work: string; history: string };
	task_index: Record<string, string>;
}

@Injectable()
export class BackupService {
	private readonly log = new Logger(BackupService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly credentials: CredentialsService,
		private readonly clickup: ClickUpDirectService,
	) {}

	async take(
		projectId: string,
		trigger: BackupTrigger = "manual",
	): Promise<BackupRecord> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");

		const creds = await this.credentials.forOrg(project.organisation_id);

		// Per-repo Space model has no single clickup_folder_id (multiple
		// Folders live under one Space). Skip the legacy folder probe and
		// stub out the folder block for snapshot consumers that still expect
		// it. Old projects that *do* have a clickup_folder_id still resolve.
		const folder = project.clickup_folder_id
			? await this.clickup.getFolder(project.clickup_folder_id, creds.token)
			: { id: "", name: project.display_name ?? projectId };
		const inverseTaskIndex = invertTaskIndex(project.task_index);

		const listEntries: Array<{ id: string; key: string; name: string }> = [];
		const tasks: SnapshotTask[] = [];

		for (const [key, listId] of Object.entries(project.list_ids)) {
			try {
				const listTasks = await this.clickup.listTasksInList(
					listId,
					creds.token,
				);
				listEntries.push({
					id: listId,
					key,
					name: this.deriveListName(listTasks, key),
				});

				for (const t of listTasks) {
					tasks.push({
						id: t.id,
						list_id: listId,
						list_key: key,
						task_key: inverseTaskIndex[t.id] ?? `clickup:${t.id}`,
						name: t.name,
						markdown_description:
							t.markdown_description ?? t.description ?? t.text_content ?? "",
						status: t.status?.status ?? "open",
					});
				}
			} catch (err) {
				this.log.warn(
					`snapshot list ${key} (${listId}) failed: ${(err as Error).message}`,
				);
			}
		}

		const snapshot: BackupSnapshot = {
			schema_version: 1,
			taken_at: new Date().toISOString(),
			folder: { id: folder.id, name: folder.name },
			lists: listEntries,
			tasks,
		};

		const inserted = await this.prisma.$queryRawUnsafe<
			Array<{ id: string; taken_at: Date }>
		>(
			`INSERT INTO clickup_tracker.backups (project_id, trigger, snapshot)
       VALUES ($1::uuid, $2, $3::jsonb)
       RETURNING id, taken_at`,
			project.id,
			trigger,
			JSON.stringify(snapshot),
		);

		return {
			id: inserted[0].id,
			project_id: project.id,
			trigger,
			taken_at: inserted[0].taken_at,
			task_count: tasks.length,
			list_count: listEntries.length,
		};
	}

	async list(projectId: string): Promise<BackupRecord[]> {
		const rows = await this.prisma.$queryRawUnsafe<
			Array<{
				id: string;
				project_id: string;
				trigger: BackupTrigger;
				taken_at: Date;
				snapshot: BackupSnapshot;
			}>
		>(
			`SELECT id, project_id, trigger, taken_at, snapshot
       FROM clickup_tracker.backups
       WHERE project_id = $1::uuid
       ORDER BY taken_at DESC
       LIMIT 50`,
			projectId,
		);
		return rows.map((r) => ({
			id: r.id,
			project_id: r.project_id,
			trigger: r.trigger,
			taken_at: r.taken_at,
			task_count: r.snapshot.tasks.length,
			list_count: r.snapshot.lists.length,
		}));
	}

	async restore(
		projectId: string,
		backupId: string,
		mode: RestoreMode = "additive",
	): Promise<{
		backupId: string;
		mode: RestoreMode;
		preRevertBackupId: string;
		created: number;
		updated: number;
		skipped: number;
	}> {
		const project = await this.loadProject(projectId);
		if (!project) throw new NotFoundException("project not found");

		const snapshotRow = await this.prisma.$queryRawUnsafe<
			Array<{ snapshot: BackupSnapshot }>
		>(
			`SELECT snapshot FROM clickup_tracker.backups
       WHERE id = $1::uuid AND project_id = $2::uuid`,
			backupId,
			projectId,
		);
		if (snapshotRow.length === 0)
			throw new NotFoundException("backup not found");
		const snapshot = snapshotRow[0].snapshot;

		// Always take a pre-revert backup first.
		const preRevert = await this.take(projectId, "pre_revert");

		const creds = await this.credentials.forOrg(project.organisation_id);

		// Read current state to dedupe.
		const liveTasksByListId = new Map<string, ClickUpTaskFull[]>();
		for (const list of snapshot.lists) {
			try {
				liveTasksByListId.set(
					list.id,
					await this.clickup.listTasksInList(list.id, creds.token),
				);
			} catch {
				liveTasksByListId.set(list.id, []);
			}
		}

		let created = 0;
		let updated = 0;
		let skipped = 0;
		const newKeyToId: Record<string, string> = {};

		for (const snapTask of snapshot.tasks) {
			const live = (liveTasksByListId.get(snapTask.list_id) ?? []).find(
				(t) => t.id === snapTask.id || t.name === snapTask.name,
			);

			if (!live) {
				// Task was deleted post-snapshot — recreate it (additive + merge + replace all do this).
				try {
					const fresh = await this.clickup.createTask(
						snapTask.list_id,
						{
							name: snapTask.name,
							markdown_content: snapTask.markdown_description,
						},
						creds.token,
					);
					if (snapTask.task_key && !snapTask.task_key.startsWith("clickup:")) {
						newKeyToId[snapTask.task_key] = fresh.id;
					}
					created++;
				} catch (err) {
					this.log.warn(`restore createTask failed: ${(err as Error).message}`);
					skipped++;
				}
			} else if (mode === "merge" || mode === "replace") {
				const liveDesc =
					live.markdown_description ??
					live.description ??
					live.text_content ??
					"";
				if (
					live.name !== snapTask.name ||
					liveDesc.trim() !== snapTask.markdown_description.trim()
				) {
					try {
						await this.clickup.updateTask(
							live.id,
							{
								name: snapTask.name,
								markdown_content: snapTask.markdown_description,
							},
							creds.token,
						);
						updated++;
					} catch (err) {
						this.log.warn(
							`restore updateTask failed: ${(err as Error).message}`,
						);
						skipped++;
					}
				} else {
					skipped++;
				}
			} else {
				// additive mode: existing task — leave alone.
				skipped++;
			}
		}

		if (Object.keys(newKeyToId).length > 0) {
			await this.appendToTaskIndex(project.id, newKeyToId);
		}

		return {
			backupId,
			mode,
			preRevertBackupId: preRevert.id,
			created,
			updated,
			skipped,
		};
	}

	private async loadProject(
		projectId: string,
	): Promise<ProjectForBackup | null> {
		const rows = await this.prisma.$queryRawUnsafe<ProjectForBackup[]>(
			`SELECT id, organisation_id, display_name, clickup_folder_id,
              list_ids::jsonb AS list_ids, task_index::jsonb AS task_index
       FROM clickup_tracker.projects
       WHERE id = $1::uuid AND status <> 'removed'`,
			projectId,
		);
		return rows[0] ?? null;
	}

	private async appendToTaskIndex(
		projectId: string,
		additions: Record<string, string>,
	): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`UPDATE clickup_tracker.projects
       SET task_index = task_index || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1::uuid`,
			projectId,
			JSON.stringify(additions),
		);
	}

	private deriveListName(tasks: ClickUpTaskFull[], key: string): string {
		return tasks[0]?.list ? key : key;
	}
}

function invertTaskIndex(idx: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(idx)) out[v] = k;
	return out;
}
