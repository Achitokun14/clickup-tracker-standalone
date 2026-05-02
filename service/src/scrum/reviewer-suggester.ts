import { Injectable, Logger } from "@nestjs/common";
import { OwnershipService } from "./ownership.service";

/**
 * Plan §K.5 — auto-suggest reviewers from the file ownership map.
 *
 * Given the set of files a PR touches, returns the top-N owners across
 * those files (excluding the PR author). The suggested-reviewers comment
 * is composed by the caller (PR-14 GitHub webhook handler will be the
 * primary call site once it lands).
 */
@Injectable()
export class ReviewerSuggesterService {
	private readonly log = new Logger(ReviewerSuggesterService.name);

	constructor(private readonly ownership: OwnershipService) {}

	async suggestForFiles(
		projectId: string,
		paths: string[],
		options: { excludeEmail?: string; topN?: number } = {},
	): Promise<Array<{ email: string; score: number }>> {
		const topN = options.topN ?? 3;
		const exclude = (options.excludeEmail ?? "").toLowerCase();
		// Aggregate owner scores across every touched file.
		const tally = new Map<string, number>();
		for (const path of paths) {
			let owners: Awaited<ReturnType<OwnershipService["topOwnersForPath"]>> =
				[];
			try {
				owners = await this.ownership.topOwnersForPath(projectId, path, 5);
			} catch (err) {
				this.log.debug(
					`reviewer suggest topOwnersForPath(${path}) failed: ${(err as Error).message}`,
				);
				continue;
			}
			for (const o of owners) {
				if (o.email === exclude) continue;
				tally.set(o.email, (tally.get(o.email) ?? 0) + o.score);
			}
		}
		return [...tally.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, topN)
			.map(([email, score]) => ({ email, score }));
	}
}

/**
 * Pure renderer: format the suggested-reviewers list as a CU/GitHub
 * comment line. Returns empty string when the list is empty so callers
 * can short-circuit on no-data.
 */
export function renderSuggestedReviewersMd(
	suggestions: Array<{ email: string; score: number }>,
): string {
	if (suggestions.length === 0) return "";
	const cells = suggestions.map((s) => `\`${s.email}\``).join(", ");
	return `**Suggested reviewers:** ${cells}`;
}
