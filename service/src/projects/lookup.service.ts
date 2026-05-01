import { Injectable, Logger } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CredentialsService } from "../credentials/credentials.service";
import { parseGitRemote } from "../util/git-remote-parse";

/**
 * Plan §B.1 — read-only lookup endpoint backing the multi-developer
 * "adopt-vs-create" decision tree. Given a candidate displayName + git
 * remote, return the Spaces in the workspace that *might* already be
 * tracking this repo, ranked by match strength so the controller can
 * 200/auto-adopt single strong matches and 409 with candidates on
 * multi-strong.
 *
 * Three tiers of match strength:
 *   strong  — first-page task descriptions in the Space mention the same
 *             git_remote_url footer (most reliable; same repo, different
 *             local clone).  Costs one extra API call per candidate.
 *   medium  — Space name == kebab(ownerRepo) (case-insensitive) OR
 *             == displayName (case-insensitive).
 *   weak    — Space name contains kebab(displayName) as a substring.
 *
 * Strong matching is opt-in via `scanFooters: true` to avoid fan-out on
 * "/projects/lookup" calls that fire from every /clickup-add invocation.
 */

export interface LookupMatch {
	spaceId: string;
	spaceName: string;
	strength: "strong" | "medium" | "weak";
	reason: string;
}

export interface LookupArgs {
	orgId: string;
	displayName: string;
	gitRemoteUrl?: string | null;
	scanFooters?: boolean;
}

interface CacheEntry {
	at: number;
	matches: LookupMatch[];
}

const CACHE_TTL_MS = 60_000;
const FOOTER_SAMPLE_LIMIT = 8;

@Injectable()
export class LookupService {
	private readonly log = new Logger(LookupService.name);
	private readonly cache = new Map<string, CacheEntry>();

	constructor(
		private readonly clickup: ClickUpDirectService,
		private readonly credentials: CredentialsService,
	) {}

	async lookup(args: LookupArgs): Promise<LookupMatch[]> {
		const cacheKey = `${args.orgId}|${args.displayName}|${args.gitRemoteUrl ?? ""}|${args.scanFooters ? "deep" : "shallow"}`;
		const hit = this.cache.get(cacheKey);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.matches;

		const creds = await this.credentials.forOrg(args.orgId);
		const spaces = await this.clickup.listSpaces(creds.team_id, creds.token);
		const parsed = args.gitRemoteUrl ? parseGitRemote(args.gitRemoteUrl) : null;
		const ownerRepoSlug = parsed ? kebab(parsed.ownerRepo) : null;
		const displayNameSlug = kebab(args.displayName);
		const wantedRemote = (args.gitRemoteUrl ?? "").trim();

		const matches: LookupMatch[] = [];

		for (const s of spaces) {
			const name = (s.name ?? "").trim();
			const lname = name.toLowerCase();

			// Strong — only when explicitly asked AND we have a remote URL.
			if (args.scanFooters && wantedRemote) {
				const found = await this.scanFooterForRemote(
					s.id,
					wantedRemote,
					creds.token,
				);
				if (found) {
					matches.push({
						spaceId: s.id,
						spaceName: name,
						strength: "strong",
						reason: `git_remote_url match in task description footer`,
					});
					continue;
				}
			}

			// Medium — exact slug match on owner/repo
			if (ownerRepoSlug && lname === ownerRepoSlug) {
				matches.push({
					spaceId: s.id,
					spaceName: name,
					strength: "medium",
					reason: `Space name matches owner/repo slug "${ownerRepoSlug}"`,
				});
				continue;
			}

			// Medium — case-insensitive displayName match
			if (lname === args.displayName.toLowerCase()) {
				matches.push({
					spaceId: s.id,
					spaceName: name,
					strength: "medium",
					reason: `displayName match (case-insensitive)`,
				});
				continue;
			}

			// Weak — kebab-case substring
			if (displayNameSlug && lname.includes(displayNameSlug)) {
				matches.push({
					spaceId: s.id,
					spaceName: name,
					strength: "weak",
					reason: `Space name contains "${displayNameSlug}"`,
				});
			}
		}

		this.cache.set(cacheKey, { at: Date.now(), matches });
		return matches;
	}

	private async scanFooterForRemote(
		spaceId: string,
		remoteUrl: string,
		token: string,
	): Promise<boolean> {
		try {
			const folders = await this.clickup.listFolders(spaceId, token);
			for (const folder of folders.slice(0, 4)) {
				const lists = await this.clickup.listListsInFolder(folder.id, token);
				for (const list of lists.slice(0, 2)) {
					const tasks = await this.clickup.listTasksInList(list.id, token);
					for (const t of tasks.slice(0, FOOTER_SAMPLE_LIMIT)) {
						const desc =
							(t as { markdown_description?: string; description?: string })
								.markdown_description ??
							(t as { description?: string }).description ??
							"";
						if (desc.includes(`Remote: ${remoteUrl}`)) return true;
					}
				}
			}
		} catch (err) {
			this.log.warn(
				`scanFooterForRemote(space=${spaceId}) failed: ${(err as Error).message}`,
			);
		}
		return false;
	}
}

function kebab(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
