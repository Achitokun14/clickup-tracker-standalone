export interface TagColor {
	fg: string;
	bg: string;
}

const DEFAULT: TagColor = { fg: "#000000", bg: "#E5E7EB" };

export function tagPalette(tag: string): TagColor {
	const t = (tag ?? "").toLowerCase();
	if (t.startsWith("epic:")) return { fg: "#FFFFFF", bg: "#3B82F6" };
	if (t === "severity:critical") return { fg: "#FFFFFF", bg: "#DC2626" };
	if (t === "severity:high") return { fg: "#FFFFFF", bg: "#EA580C" };
	if (t === "severity:medium") return { fg: "#000000", bg: "#FBBF24" };
	if (t === "severity:low") return { fg: "#FFFFFF", bg: "#10B981" };
	if (t.startsWith("type:feat")) return { fg: "#FFFFFF", bg: "#8B5CF6" };
	if (t.startsWith("type:fix")) return { fg: "#FFFFFF", bg: "#F43F5E" };
	if (t.startsWith("type:chore")) return { fg: "#FFFFFF", bg: "#64748B" };
	if (t.startsWith("type:docs")) return { fg: "#FFFFFF", bg: "#0EA5E9" };
	if (t.startsWith("type:refactor")) return { fg: "#FFFFFF", bg: "#14B8A6" };
	if (t.startsWith("type:")) return { fg: "#FFFFFF", bg: "#6366F1" };
	if (t.startsWith("source:")) return { fg: "#FFFFFF", bg: "#6B7280" };
	if (t === "duplicate" || t.startsWith("tag:duplicate"))
		return { fg: "#000000", bg: "#FDE68A" };
	if (t === "stale-bug" || t === "carryover-overdue")
		return { fg: "#FFFFFF", bg: "#9333EA" };
	if (t === "auto-archived" || t === "watch")
		return { fg: "#FFFFFF", bg: "#475569" };
	if (t === "infra-change") return { fg: "#FFFFFF", bg: "#0F766E" };
	if (t === "new-module") return { fg: "#FFFFFF", bg: "#0891B2" };
	if (t === "dependency-review") return { fg: "#FFFFFF", bg: "#A16207" };
	if (t === "needs-reassignment") return { fg: "#FFFFFF", bg: "#B91C1C" };
	if (t === "scope-renamed") return { fg: "#FFFFFF", bg: "#7C3AED" };
	return DEFAULT;
}
