import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §C.0 — every autonomous SCRUM action emits a row in
 * `clickup_tracker.scrum_audit` so operators can browse what the
 * daemon did and why. Browsable via GET /projects/:id/scrum/audit.
 *
 * The table is created in schema/03_collab_and_scrum.sql.
 */

export interface AuditRecordArgs {
	projectId: string;
	kind: string;
	target?: string | null;
	before?: unknown;
	after?: unknown;
	reason: string;
	dryRun?: boolean;
}

export interface AuditRow {
	id: string;
	project_id: string;
	at: Date;
	kind: string;
	target: string | null;
	before: unknown;
	after: unknown;
	reason: string;
	dry_run: boolean;
}

@Injectable()
export class AuditService {
	private readonly log = new Logger(AuditService.name);

	constructor(private readonly prisma: PrismaService) {}

	async record(args: AuditRecordArgs): Promise<void> {
		try {
			await this.prisma.$executeRawUnsafe(
				`INSERT INTO clickup_tracker.scrum_audit
           (project_id, kind, target, before, after, reason, dry_run)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
				args.projectId,
				args.kind,
				args.target ?? null,
				args.before == null ? null : JSON.stringify(args.before),
				args.after == null ? null : JSON.stringify(args.after),
				args.reason,
				Boolean(args.dryRun),
			);
		} catch (err) {
			// Never let audit failure mask the real action result.
			this.log.warn(
				`audit record failed (kind=${args.kind} project=${args.projectId}): ${(err as Error).message}`,
			);
		}
	}

	async list(
		projectId: string,
		opts: { since?: string; kind?: string; limit?: number } = {},
	): Promise<AuditRow[]> {
		const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
		const params: unknown[] = [projectId];
		const where: string[] = ["project_id = $1::uuid"];
		if (opts.since) {
			params.push(opts.since);
			where.push(`at > $${params.length}::timestamptz`);
		}
		if (opts.kind) {
			params.push(opts.kind);
			where.push(`kind = $${params.length}`);
		}
		params.push(limit);
		const rows = await this.prisma.$queryRawUnsafe<AuditRow[]>(
			`SELECT id, project_id, at, kind, target, before, after, reason, dry_run
       FROM clickup_tracker.scrum_audit
       WHERE ${where.join(" AND ")}
       ORDER BY at DESC
       LIMIT $${params.length}`,
			...params,
		);
		return rows;
	}
}
