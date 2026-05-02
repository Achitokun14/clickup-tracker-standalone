/**
 * Plan §I.3 — parse `Co-authored-by:` trailers from a commit body. Used by
 * events.service to credit pair-programming partners as commit_authors and
 * (when their email is known to GitHub) add them as task watchers.
 *
 * Format per Git convention:
 *   Co-authored-by: Display Name <email@host>
 *
 * - Whitespace tolerant
 * - Case-insensitive on the trailer key
 * - Deduped by lowercased email so `Bob <bob@x>` + `BOB <BOB@X>` count once
 * - Returns empty array on no body / no matches
 */

export interface CoAuthor {
	name: string;
	email: string;
}

const TRAILER_RX = /^\s*Co-authored-by:\s*(.+?)\s*<\s*([^>\s]+)\s*>\s*$/im;

export function parseCoAuthors(body: string | null | undefined): CoAuthor[] {
	if (!body) return [];
	const seen = new Set<string>();
	const out: CoAuthor[] = [];
	for (const line of body.split(/\r?\n/)) {
		const m = TRAILER_RX.exec(line);
		if (!m) continue;
		const name = (m[1] ?? "").trim();
		const email = (m[2] ?? "").trim().toLowerCase();
		if (!email || seen.has(email)) continue;
		seen.add(email);
		out.push({ name, email });
	}
	return out;
}
