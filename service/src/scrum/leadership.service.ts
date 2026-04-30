import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plan §C.0 / §C.11 — single-leader-per-workspace SCRUM crons. When two
 * developers run daemons against the same workspace, only one should
 * actually execute the sprint planner / groomer / standup tick. Use
 * Postgres advisory transaction locks keyed by `(team_id, lockName)` to
 * elect the leader cheaply: the first transaction to grab the lock runs
 * the work; later attempts get `not_leader` and silently skip.
 *
 * `pg_try_advisory_xact_lock` releases on commit/rollback automatically,
 * so a daemon crash mid-cron leaves no stuck locks.
 */

export type LeadershipResult<T> =
	| { leader: true; value: T }
	| { leader: false; reason: "not_leader" };

@Injectable()
export class LeadershipService {
	private readonly log = new Logger(LeadershipService.name);

	constructor(private readonly prisma: PrismaService) {}

	/**
	 * Run `fn` inside a Postgres advisory transaction lock keyed by
	 * `(hash(teamId), hash(lockName))`. Returns `{leader: true}` if this
	 * daemon won the lock; `{leader: false, reason: 'not_leader'}` if a
	 * peer already holds it. Both branches are normal — the caller logs
	 * `not_leader` and moves on.
	 *
	 * Caveat: `fn` runs inside a long-lived transaction. Long ClickUp
	 * API loops inside the transaction can block other operations on
	 * the same connection. For the sprint planner specifically, prefer
	 * `withSessionLock` (TODO if needed) — this xact-lock variant is
	 * fine for groomer/standup/retro which only do quick DB reads.
	 */
	async withLeadership<T>(
		teamId: string,
		lockName: string,
		fn: () => Promise<T>,
	): Promise<LeadershipResult<T>> {
		const k1 = hashTo32(teamId);
		const k2 = hashTo32(lockName);

		// Run inside a single transaction so pg_try_advisory_xact_lock
		// holds for the duration and releases on commit.
		const tx = (this.prisma as any).$transaction.bind(this.prisma);
		const out: LeadershipResult<T> = await tx(async (t: any) => {
			const r = (await t.$queryRawUnsafe(
				`SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS lock`,
				k1,
				k2,
			)) as Array<{ lock: boolean }>;
			if (!r[0]?.lock) {
				return { leader: false as const, reason: "not_leader" as const };
			}
			const value = await fn();
			return { leader: true as const, value };
		});
		return out;
	}
}

/**
 * Hash an arbitrary string to a signed 32-bit int suitable for
 * pg_try_advisory_xact_lock(int, int). Uses SHA-256 → first 4 bytes,
 * interpreted as signed int32 to fit Postgres' int range.
 */
export function hashTo32(s: string): number {
	const buf = createHash("sha256").update(s).digest();
	// Read first 4 bytes as a 32-bit signed integer (big-endian).
	return buf.readInt32BE(0);
}
