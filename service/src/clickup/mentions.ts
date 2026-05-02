/**
 * Build structured comment segments with @-mentions for the CU v2 comment
 * array form. Tokens of the form `{@email}` in the template are replaced
 * with mention segments when the email resolves to a known workspace
 * member; unresolved tokens fall back to plain `@email` text so humans
 * can still read the comment.
 */
export interface CommentSegment {
	text: string;
	attributes?: {
		mention?: { user_id: number };
		bold?: boolean;
		italic?: boolean;
		code?: boolean;
	};
}

const MENTION_TOKEN = /\{@([^}]+)\}/g;

export function buildMentionedComment(
	template: string,
	resolveMember: (email: string) => number | null | undefined,
): CommentSegment[] {
	const segments: CommentSegment[] = [];
	let last = 0;
	for (const m of template.matchAll(MENTION_TOKEN)) {
		const start = m.index ?? 0;
		if (start > last) {
			segments.push({ text: template.slice(last, start) });
		}
		const email = m[1].trim();
		const userId = email ? resolveMember(email) : null;
		if (userId) {
			segments.push({
				text: `@${email}`,
				attributes: { mention: { user_id: userId } },
			});
		} else {
			segments.push({ text: `@${email}` });
		}
		last = start + m[0].length;
	}
	if (last < template.length) {
		segments.push({ text: template.slice(last) });
	}
	if (segments.length === 0) {
		segments.push({ text: template });
	}
	return segments;
}

/**
 * True when at least one segment carries a mention attribute. Callers use
 * this to decide whether to fall back to the plain-text addComment path
 * (when no mentions resolved, the structured form has no advantage).
 */
export function hasMention(segments: CommentSegment[]): boolean {
	return segments.some((s) => s.attributes?.mention?.user_id != null);
}
