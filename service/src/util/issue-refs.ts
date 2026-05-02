/**
 * Plan §K.6 — extract issue references from a commit message body.
 *
 * Recognised forms:
 *   #123                  — local repo
 *   GH-123                — GitHub-flavoured prefix
 *   JIRA-456 / ABC-7      — uppercase letters + dash + digits
 *   <owner>/<repo>#NN     — cross-repo GitHub
 *
 * Caller decides what to do with each match — typically:
 *   - look up the linked CU task via task_index['issue:NN'] and
 *     addTaskLink to the commit task
 *   - fall through to addTaskAttachment with the external URL
 */

export interface IssueRef {
	kind: "local" | "gh-cross-repo" | "jira-like";
	raw: string;
	number?: string;
	ownerRepo?: string; // for gh-cross-repo
	key?: string; // for jira-like (e.g. "BUG-7")
}

const CROSS_REPO_RX = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const GH_PREFIXED_RX = /\bGH-(\d+)\b/g;
const HASH_RX = /(?<![A-Za-z0-9/])#(\d+)\b/g;
const JIRA_RX = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;

export function extractIssueRefs(
	message: string | null | undefined,
): IssueRef[] {
	if (!message) return [];
	const out: IssueRef[] = [];
	const seen = new Set<string>();

	// Cross-repo first (most specific) — strip them before hash matching.
	const crMatches: Array<{ start: number; end: number }> = [];
	let m: RegExpExecArray | null;
	const crRx = new RegExp(CROSS_REPO_RX);
	while ((m = crRx.exec(message)) !== null) {
		const raw = m[0];
		if (seen.has(raw)) continue;
		seen.add(raw);
		crMatches.push({ start: m.index, end: m.index + raw.length });
		out.push({
			kind: "gh-cross-repo",
			raw,
			ownerRepo: `${m[1]}/${m[2]}`,
			number: m[3],
		});
	}

	// Mask cross-repo regions before secondary scans so the # in `foo/bar#7`
	// doesn't double-count as a local issue.
	const masked = maskRanges(message, crMatches);

	const ghRx = new RegExp(GH_PREFIXED_RX);
	while ((m = ghRx.exec(masked)) !== null) {
		const raw = m[0];
		if (seen.has(raw)) continue;
		seen.add(raw);
		out.push({ kind: "local", raw, number: m[1] });
	}

	const hashRx = new RegExp(HASH_RX);
	while ((m = hashRx.exec(masked)) !== null) {
		const raw = m[0];
		if (seen.has(raw)) continue;
		seen.add(raw);
		out.push({ kind: "local", raw, number: m[1] });
	}

	const jiraRx = new RegExp(JIRA_RX);
	while ((m = jiraRx.exec(masked)) !== null) {
		const raw = m[0];
		if (seen.has(raw)) continue;
		seen.add(raw);
		out.push({
			kind: "jira-like",
			raw,
			key: `${m[1]}-${m[2]}`,
		});
	}

	return out;
}

function maskRanges(
	src: string,
	ranges: Array<{ start: number; end: number }>,
): string {
	if (ranges.length === 0) return src;
	const arr = [...src];
	for (const r of ranges) {
		for (let i = r.start; i < r.end && i < arr.length; i++) arr[i] = " ";
	}
	return arr.join("");
}
