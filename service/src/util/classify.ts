/**
 * Classification heuristics ported verbatim from BGMT's
 * `generate_clickup_csvs.py` (lines 218–870 of that file).
 *
 * The Python script has been validated by the user against ~1,659 commits
 * across 9 real projects, so we keep the keyword lists, scoring, and
 * fallback rules character-for-character. See plan Appendix A.
 *
 * Conventional-commit parsing stays in `events/conventional.ts`; we
 * re-export it from here so callers have a single classifier surface.
 */

export {
	parseConventional,
	normaliseScope,
	type ConventionalCommit,
} from "../events/conventional";

// ---------- type taxonomy ----------

export type ConventionalType =
	| "Feature"
	| "Bug Fix"
	| "Refactor"
	| "Docs"
	| "Chore"
	| "Style"
	| "Performance"
	| "Test"
	| "Build"
	| "CI/CD"
	| "Revert";

export type Priority = "Urgent" | "High" | "Normal" | "Low";

// ---------- BGMT constants (Appendix A) ----------

export const KEYWORD_CLUSTERS: Record<string, string[]> = {
	"i18n & Translations": [
		"i18n",
		"translation",
		"locale",
		"french",
		"spanish",
		"language",
		"intl",
	],
	"AI Chatbot": ["chatbot", "ai ", "ollama", "jetpal", "runpod", "deepseek"],
	"Admin Dashboard": ["admin dashboard", "admin-dashboard", "admin panel"],
	"Client Dashboard": ["client dashboard", "client-dashboard", "client portal"],
	"Authentication & Security": [
		"auth",
		"login",
		"jwt",
		"rbac",
		"password",
		"security",
		"csrf",
		"cors",
		"csp",
		"rate limit",
		"block",
	],
	"Deployment & DevOps": [
		"docker",
		"railway",
		"coolify",
		"deploy",
		"dockerfile",
		"nixpacks",
		"healthcheck",
	],
	"UI/UX Design": [
		"responsive",
		"layout",
		"style",
		"theme",
		"css",
		"glassmorphism",
		"grainient",
		"animation",
		"ui",
	],
	"API Development": [
		"endpoint",
		"api ",
		"route",
		"proxy",
		"collection",
		"postman",
		"insomnia",
	],
	Database: [
		"database",
		"mongodb",
		"postgresql",
		"scylladb",
		"redis",
		"migration",
		"schema",
		"seed",
	],
	Documentation: ["docs", "readme", "changelog", "documentation", "roadmap"],
	Testing: ["test", "spec", "coverage"],
	Branding: ["logo", "favicon", "brand", "icon", "avatar"],
	"Booking & Flights": [
		"booking",
		"flight",
		"aircraft",
		"flyeasy",
		"quoting",
		"empty leg",
	],
	"Scraping & Data": [
		"scraper",
		"scraping",
		"crawl",
		"lead finder",
		"search engine",
	],
	"Monitoring & Analytics": [
		"monitoring",
		"analytics",
		"grafana",
		"prometheus",
		"loki",
		"telemetry",
		"metrics",
	],
	"Email & Notifications": [
		"email",
		"smtp",
		"notification",
		"resend",
		"campaign",
	],
	"Payment & Billing": ["payment", "stripe", "billing", "credit", "pricing"],
	"CRM & PM": [
		"crm",
		"kanban",
		"sprint",
		"gantt",
		"workspace",
		"project management",
	],
	"VIP Services": ["vip", "concierge", "premium"],
	"Forms & Validation": ["form", "recaptcha", "validation", "input"],
	"Three.js & 3D": ["three.js", "3d", "globe", "webgl", "shader"],
};

export const TAG_KEYWORDS: Record<string, string[]> = {
	frontend: [
		"react",
		"svelte",
		"vue",
		"nuxt",
		"next",
		"angular",
		"css",
		"tailwind",
		"ui",
		"component",
		"page",
		"layout",
		"responsive",
	],
	backend: [
		".go",
		"beego",
		"python",
		"flask",
		"express",
		"api",
		"endpoint",
		"route",
		"service",
		"middleware",
	],
	infra: [
		"docker",
		"railway",
		"coolify",
		"deploy",
		"dockerfile",
		"kubernetes",
		"nginx",
		"caddy",
	],
	database: [
		"mongodb",
		"postgresql",
		"scylladb",
		"redis",
		"sqlite",
		"database",
		"migration",
		"schema",
	],
	security: [
		"security",
		"auth",
		"jwt",
		"cors",
		"csrf",
		"csp",
		"xss",
		"sql injection",
		"rate limit",
		"vulnerability",
	],
	ai: [
		"chatbot",
		"ai",
		"ollama",
		"deepseek",
		"machine learning",
		"ml",
		"prediction",
	],
	i18n: ["i18n", "translation", "locale", "language", "french", "spanish"],
	api: ["api", "endpoint", "rest", "webhook", "postman", "insomnia"],
	docs: ["docs", "readme", "changelog", "documentation"],
	testing: ["test", "spec", "coverage", "debug"],
};

/** Default email-normalisation map. Per-project overrides via `scope_config.authorMap`. */
export const AUTHOR_MAP: Record<string, string> = {
	"achrafalaoui14@gmail.com": "achrafalaoui14@gmail.com",
	"bazigards@proton.me": "achrafalaoui14@gmail.com",
	"53955673+Achitokun14@users.noreply.github.com": "achrafalaoui14@gmail.com",
	"kennsey@localhost.localdomain": "kennsey@localhost.localdomain",
	"noreply@anthropic.com": "noreply@anthropic.com",
};

// ---------- BGMT classifyType (lines 814–836) ----------

const PREFIX_MAP: Record<string, ConventionalType> = {
	feat: "Feature",
	fix: "Bug Fix",
	docs: "Docs",
	refactor: "Refactor",
	chore: "Chore",
	style: "Style",
	perf: "Performance",
	test: "Test",
	build: "Build",
	ci: "CI/CD",
	revert: "Revert",
	restructure: "Refactor",
};

export function classifyType(subject: string, body = ""): ConventionalType {
	const msg = `${subject} ${body}`.toLowerCase().trim();
	const head = msg.split(/\s|:|\(/)[0];
	for (const [prefix, type] of Object.entries(PREFIX_MAP)) {
		if (
			head === prefix ||
			msg.startsWith(`${prefix}:`) ||
			msg.startsWith(`${prefix}(`)
		) {
			return type;
		}
	}
	if (/\b(fix|bug|resolve|patch|hotfix)\b/.test(msg)) return "Bug Fix";
	if (/\b(add|new|implement|create|enhance|improve)\b/.test(msg))
		return "Feature";
	if (/\b(restructure|reorganize|rename|move|split)\b/.test(msg))
		return "Refactor";
	if (/\b(doc|readme|comment|changelog)\b/.test(msg)) return "Docs";
	if (/\b(deploy|docker|railway|release)\b/.test(msg)) return "Build";
	return "Chore";
}

// ---------- BGMT assignPriority (lines 839–849) ----------

const PRIORITY_BY_TYPE: Record<ConventionalType, Priority> = {
	"Bug Fix": "High",
	Feature: "Normal",
	Performance: "Normal",
	Refactor: "Low",
	Docs: "Low",
	Chore: "Low",
	Style: "Low",
	Test: "Normal",
	Build: "Normal",
	"CI/CD": "Low",
	Revert: "High",
};

export function assignPriority(
	type: ConventionalType,
	subject: string,
	body = "",
): Priority {
	const msg = `${subject} ${body}`.toLowerCase();
	if (/\b(security|vulnerability|xss|injection|critical)\b/.test(msg))
		return "Urgent";
	return PRIORITY_BY_TYPE[type] ?? "Normal";
}

/** Convert priority label to ClickUp's 1..4 integer (1=urgent, 4=low). */
export function priorityToCu(p: Priority): 1 | 2 | 3 | 4 {
	return ({ Urgent: 1, High: 2, Normal: 3, Low: 4 } as const)[p];
}

// ---------- BGMT classifyEpic (lines 861–870, scoring port) ----------

export function classifyEpic(subject: string, body = ""): string {
	const msg = `${subject} ${body}`.toLowerCase();
	let bestScore = 0;
	let best: string | null = null;
	for (const [cluster, kws] of Object.entries(KEYWORD_CLUSTERS)) {
		let score = 0;
		for (const kw of kws) if (msg.includes(kw)) score += 1;
		if (score > bestScore) {
			bestScore = score;
			best = cluster;
		}
	}
	return best ?? "General Development";
}

// ---------- BGMT deriveTags (lines 852–858, enriched) ----------

const KEBAB_RX = /[^a-z0-9]+/g;
function kebab(s: string): string {
	return s
		.toLowerCase()
		.replace(KEBAB_RX, "-")
		.replace(/(^-|-$)/g, "");
}

export interface DeriveTagsArgs {
	subject: string;
	body?: string;
	files?: string[];
	type: ConventionalType;
	source: string;
	epic: string;
}

export function deriveTags(args: DeriveTagsArgs): string[] {
	const { subject, body = "", files = [], type, source, epic } = args;
	const msg = `${subject} ${body}`.toLowerCase();
	const tags = new Set<string>();

	// BGMT keyword scan over subject+body.
	for (const [tag, kws] of Object.entries(TAG_KEYWORDS)) {
		if (kws.some((kw) => msg.includes(kw))) tags.add(tag);
	}

	// File-path heuristics (additive — beyond BGMT).
	if (files.some((f) => /\.(tsx?|jsx?|css|scss|html|svelte|vue)$/i.test(f)))
		tags.add("frontend");
	if (files.some((f) => /\.(go|py|rb|java|cs|rs)$/i.test(f)))
		tags.add("backend");
	if (files.some((f) => /Dockerfile|docker-compose|\.ya?ml$/i.test(f)))
		tags.add("infra");
	if (files.some((f) => /\.sql$|prisma\/|drizzle\/|\/migrations\//i.test(f)))
		tags.add("database");

	if (tags.size === 0) tags.add("general");

	// Type / Source / Epic namespaced tags so views can group/filter cleanly.
	tags.add(`type:${kebab(type)}`);
	tags.add(`source:${kebab(source)}`);
	tags.add(`epic:${kebab(epic)}`);

	return [...tags].sort();
}

// ---------- estimateMinutes (BGMT fallback `:1001–1007`, augmented) ----------

export function estimateMinutes(
	filesChanged: number,
	locDelta: number,
	_type: ConventionalType,
): number {
	// BGMT fallback when no real session data is available: 30 min × commits-in-group.
	// Augmented: scale modestly with diff size (cap +210 min, total 4 h).
	const base = 30;
	const locBonus = Math.min(210, Math.floor(locDelta / 50) * 10);
	const fileBonus = Math.min(60, Math.floor(filesChanged / 5) * 10);
	return base + locBonus + fileBonus;
}

// ---------- author normalisation ----------

export function normalizeAuthor(
	email: string,
	projectAuthorMap?: Record<string, string>,
): string {
	if (!email) return "";
	const lower = email.toLowerCase().trim();
	if (projectAuthorMap?.[email]) return projectAuthorMap[email];
	if (projectAuthorMap?.[lower]) return projectAuthorMap[lower];
	if (AUTHOR_MAP[email]) return AUTHOR_MAP[email];
	if (AUTHOR_MAP[lower]) return AUTHOR_MAP[lower];
	return lower;
}
