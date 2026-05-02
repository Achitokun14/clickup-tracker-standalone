import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface GithubIdentity {
	email: string;
	github_login: string | null;
	github_url: string | null;
	avatar_url: string | null;
	resolved_at: Date;
	source: string;
}

interface GithubCommitApiResponse {
	author?: {
		login?: string;
		avatar_url?: string;
		html_url?: string;
	} | null;
	commit?: {
		author?: { email?: string };
	};
}

const GITHUB_API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RATE_LIMIT_HALT_MS = 60 * 1000; // hold off all fetches for 60s when remaining<5

/**
 * Resolves commit author email → GitHub identity (login / avatar / profile
 * URL) via the GitHub commits API. Cached in `clickup_tracker.github_identities`
 * keyed on lowercase email.
 *
 * - GITHUB_TOKEN env (optional): boosts unauth 60/h to authed 5000/h.
 * - Negative cache: 404s and rate-limit-exhausted lookups store a row with
 *   null github_* fields and `resolved_at = now()`; retried after 24h.
 * - Per-process rate-limit guard: when X-Ratelimit-Remaining drops below 5,
 *   halt new fetches for 60s (cache hits and stale negative-cache lookups
 *   still served).
 *
 * Plan §F.1.
 */
@Injectable()
export class GithubIdentityService {
	private readonly log = new Logger(GithubIdentityService.name);
	private rateLimitHaltUntil = 0;

	constructor(private readonly prisma: PrismaService) {}

	/**
	 * Resolve identity for `email`, optionally fetching from GitHub if no
	 * cache hit. `commitSha` + `ownerRepo` are needed for the API call.
	 * Returns null when host is non-github, or when fetch is impossible
	 * and no cache row exists.
	 */
	async resolve(
		email: string,
		opts: {
			commitSha?: string | null;
			ownerRepo?: string | null;
			host?: string | null;
		} = {},
	): Promise<GithubIdentity | null> {
		if (!email || !email.includes("@")) return null;
		const lower = email.toLowerCase();

		const cached = await this.readCached(lower);
		if (cached) {
			const ageMs = Date.now() - new Date(cached.resolved_at).getTime();
			const isNegative = !cached.github_login;
			if (!isNegative || ageMs < NEGATIVE_CACHE_TTL_MS) {
				return cached;
			}
		}

		// Need to fetch — but only if we have repo coordinates and host is github.
		const host = (opts.host ?? "").toLowerCase();
		const ownerRepo = opts.ownerRepo ?? "";
		const sha = opts.commitSha ?? "";
		if (host !== "github.com" || !ownerRepo || !sha) {
			return cached ?? null;
		}

		if (Date.now() < this.rateLimitHaltUntil) {
			this.log.debug(
				`github API rate-limit halt active until ${new Date(this.rateLimitHaltUntil).toISOString()}; serving cache or null`,
			);
			return cached ?? null;
		}

		const fetched = await this.fetchFromGithub(ownerRepo, sha);
		if (fetched.kind === "network-error") {
			// Transient — never write a 24h negative cache for a network blip.
			return cached ?? null;
		}
		if (fetched.kind === "miss") {
			// 404 / 422 → real miss. Negative-cache for 24h.
			await this.upsert({
				email: lower,
				github_login: null,
				github_url: null,
				avatar_url: null,
				source: "commit-api-miss",
				raw: null,
			});
			return cached ?? null;
		}
		const data = fetched.data;

		const identity: GithubIdentity = {
			email: lower,
			github_login: data.author?.login ?? null,
			github_url: data.author?.html_url ?? null,
			avatar_url: data.author?.avatar_url ?? null,
			resolved_at: new Date(),
			source: "commit-api",
		};
		await this.upsert({
			...identity,
			raw: data,
		});
		return identity;
	}

	private async readCached(email: string): Promise<GithubIdentity | null> {
		const rows = await this.prisma.$queryRawUnsafe<GithubIdentity[]>(
			`SELECT email, github_login, github_url, avatar_url,
			        resolved_at, source
			 FROM clickup_tracker.github_identities
			 WHERE email = $1::text LIMIT 1`,
			email,
		);
		return rows[0] ?? null;
	}

	private async upsert(row: {
		email: string;
		github_login: string | null;
		github_url: string | null;
		avatar_url: string | null;
		source: string;
		raw: unknown;
	}): Promise<void> {
		await this.prisma.$executeRawUnsafe(
			`INSERT INTO clickup_tracker.github_identities
			   (email, github_login, github_url, avatar_url, source, raw, resolved_at)
			 VALUES ($1::text, $2, $3, $4, $5::text, $6::jsonb, NOW())
			 ON CONFLICT (email) DO UPDATE SET
			   github_login = EXCLUDED.github_login,
			   github_url   = EXCLUDED.github_url,
			   avatar_url   = EXCLUDED.avatar_url,
			   source       = EXCLUDED.source,
			   raw          = EXCLUDED.raw,
			   resolved_at  = NOW()`,
			row.email,
			row.github_login,
			row.github_url,
			row.avatar_url,
			row.source,
			row.raw ? JSON.stringify(row.raw) : null,
		);
	}

	private async fetchFromGithub(
		ownerRepo: string,
		sha: string,
	): Promise<
		| { kind: "ok"; data: GithubCommitApiResponse }
		| { kind: "miss" }
		| { kind: "network-error" }
	> {
		const url = `${GITHUB_API_BASE}/repos/${ownerRepo}/commits/${encodeURIComponent(sha)}`;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "clickup-tracker-standalone",
		};
		const token = process.env.GITHUB_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;

		try {
			const r = await fetch(url, { headers });
			this.maybeArmRateLimitHalt(r.headers);
			if (!r.ok) {
				if (r.status === 404 || r.status === 422) {
					this.log.debug(`github commit ${sha.slice(0, 8)} → ${r.status}`);
					return { kind: "miss" };
				}
				if (r.status === 401 || r.status === 403) {
					this.log.warn(
						`github api ${r.status} for ${ownerRepo}@${sha.slice(0, 8)}; ` +
							`token=${token ? "set" : "absent"}`,
					);
					// Auth failures are operator-fixable — treat as transient so we
					// don't poison the cache for 24h while they rotate the token.
					return { kind: "network-error" };
				}
				this.log.warn(
					`github api ${r.status} for ${ownerRepo}@${sha.slice(0, 8)}`,
				);
				return { kind: "network-error" };
			}
			const data = (await r.json()) as GithubCommitApiResponse;
			return { kind: "ok", data };
		} catch (err) {
			this.log.warn(
				`github fetch ${ownerRepo}@${sha.slice(0, 8)} failed: ${(err as Error).message}`,
			);
			return { kind: "network-error" };
		}
	}

	private maybeArmRateLimitHalt(h: Headers): void {
		const remaining = Number(h.get("x-ratelimit-remaining") ?? "");
		if (Number.isFinite(remaining) && remaining < 5) {
			this.rateLimitHaltUntil = Date.now() + RATE_LIMIT_HALT_MS;
			this.log.warn(
				`github api rate limit nearly exhausted (remaining=${remaining}); ` +
					`halting new fetches for ${RATE_LIMIT_HALT_MS / 1000}s`,
			);
		}
	}

	/**
	 * For Phase F.4 contributors aggregator + tests.
	 */
	async listAll(): Promise<GithubIdentity[]> {
		return this.prisma.$queryRawUnsafe<GithubIdentity[]>(
			`SELECT email, github_login, github_url, avatar_url,
			        resolved_at, source
			 FROM clickup_tracker.github_identities`,
		);
	}
}
