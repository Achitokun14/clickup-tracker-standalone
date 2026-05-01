// Conventional Commits parser. Spec: https://www.conventionalcommits.org/
// Strict but forgiving — falls back to a non-conventional shape when the
// header doesn't parse, so callers can always rely on the shape.

export interface ConventionalCommit {
	type: string | null; // feat | fix | chore | …  (null = non-conventional)
	scope: string | null;
	subject: string;
	body: string;
	breaking: boolean;
	footers: Record<string, string>;
	raw: string;
	hasSkipMarker: boolean; // body or footer contains "clickup-skip"
}

const HEADER_RX =
	/^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<subject>.+)$/;
const SKIP_RX = /\bclickup-skip\b/;

export function parseConventional(message: string): ConventionalCommit {
	const raw = message.replace(/\r\n/g, "\n");
	const [headerLine, ...rest] = raw.split("\n");
	const bodyLines: string[] = [];
	const footerLines: string[] = [];

	// Footers start at the last paragraph if any line matches `Token: value`
	// or `BREAKING CHANGE:`. Walk from the end backwards.
	let inFooter = false;
	const reversedRest = [...rest];
	// Find a blank-line boundary from the back; everything after the last
	// blank that contains a footer token becomes the footer block.
	let footerStart = -1;
	for (let i = reversedRest.length - 1; i >= 0; i--) {
		if (reversedRest[i].trim() === "") {
			// candidate boundary; check the block from i+1 upwards is footer-shaped
			const block = reversedRest.slice(i + 1);
			if (block.length === 0) continue;
			const looksLikeFooter = block.every(
				(l) =>
					l.trim() === "" ||
					/^[A-Za-z-]+:\s/.test(l) ||
					/^BREAKING[ -]CHANGE:/.test(l),
			);
			if (looksLikeFooter) {
				footerStart = i + 1;
				break;
			}
		}
	}
	if (footerStart === -1) {
		bodyLines.push(...reversedRest);
	} else {
		bodyLines.push(...reversedRest.slice(0, footerStart));
		footerLines.push(...reversedRest.slice(footerStart));
	}
	inFooter; // (silence unused if simplification)

	const body = bodyLines.join("\n").trim();
	const footers: Record<string, string> = {};
	let breakingFromFooter = false;
	for (const line of footerLines) {
		const m = line.match(
			/^(?<key>[A-Za-z-]+|BREAKING[ -]CHANGE):\s*(?<value>.+)$/,
		);
		if (!m || !m.groups) continue;
		const key = m.groups.key.toUpperCase().replace(/[ -]/g, "_");
		footers[key] = m.groups.value;
		if (key === "BREAKING_CHANGE") breakingFromFooter = true;
	}

	const headerMatch = headerLine.match(HEADER_RX);
	if (!headerMatch || !headerMatch.groups) {
		return {
			type: null,
			scope: null,
			subject: headerLine.trim(),
			body,
			breaking: false,
			footers,
			raw,
			hasSkipMarker: SKIP_RX.test(raw),
		};
	}

	return {
		type: headerMatch.groups.type.toLowerCase(),
		scope: headerMatch.groups.scope ?? null,
		subject: headerMatch.groups.subject.trim(),
		body,
		breaking: Boolean(headerMatch.groups.bang) || breakingFromFooter,
		footers,
		raw,
		hasSkipMarker: SKIP_RX.test(raw),
	};
}

/** Normalise a scope match for fuzzy task lookup. Lowercase, strip non-alnum. */
export function normaliseScope(scope: string | null | undefined): string {
	return (scope ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Plan §C.3 — detect a scope rename in a Conventional Commit scope.
 *
 * Accepts both Unicode arrow (`old→new`) and ASCII arrow (`old->new`),
 * with optional surrounding whitespace. Returns `{ from, to }` for any
 * non-empty pair, or `null` when the scope is plain (no arrow).
 *
 * Matches the spirit of `refactor(legacy→v2): drop transitional shim`,
 * a pattern teams adopt when restructuring a code area.
 */
export function parseScopeRename(
	scope: string | null | undefined,
): { from: string; to: string } | null {
	if (!scope) return null;
	const m = scope.match(/^\s*(.+?)\s*(?:→|->)\s*(.+?)\s*$/);
	if (!m) return null;
	const from = m[1].trim();
	const to = m[2].trim();
	if (!from || !to || from === to) return null;
	return { from, to };
}
