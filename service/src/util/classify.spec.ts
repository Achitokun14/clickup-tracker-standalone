import {
	AUTHOR_MAP,
	assignPriority,
	classifyArtifact,
	classifyEpic,
	classifyType,
	deriveTags,
	estimateMinutes,
	KEYWORD_CLUSTERS,
	normaliseFileStatus,
	normalizeAuthor,
	priorityToCu,
	TAG_KEYWORDS,
} from "./classify";

describe("classifyType (BGMT prefix + keyword fallback)", () => {
	it.each([
		["feat: rotate JWT keys", "Feature"],
		["feat(auth): rotate JWT keys", "Feature"],
		["fix: stop drift cron from re-firing", "Bug Fix"],
		["fix(scope): X", "Bug Fix"],
		["docs: update CHANGELOG", "Docs"],
		["refactor(extractor): split planner", "Refactor"],
		["chore(deps): bump prisma", "Chore"],
		["perf(query): use partial index", "Performance"],
		["test: add fixtures", "Test"],
		["build: pin node 22 in Dockerfile", "Build"],
		["ci: cache npm modules", "CI/CD"],
		["revert: rollback bad migration", "Revert"],
		["restructure: split monorepo", "Refactor"],
	])("prefix %p → %s", (subj, expected) => {
		expect(classifyType(subj)).toBe(expected);
	});

	it.each([
		["Patch the leaky timer", "Bug Fix"],
		["Add new endpoint for billing", "Feature"],
		["Rename helper to be clearer", "Refactor"],
		["Update README intro", "Docs"],
		["Deploy to railway", "Build"],
		["Random unrelated thing", "Chore"],
	])("keyword fallback %p → %s", (subj, expected) => {
		expect(classifyType(subj)).toBe(expected);
	});
});

describe("assignPriority", () => {
	it("Bug Fix → High by default", () => {
		expect(assignPriority("Bug Fix", "fix the timer leak")).toBe("High");
	});
	it("Bug Fix in security context → Urgent", () => {
		expect(assignPriority("Bug Fix", "fix XSS vulnerability in form")).toBe(
			"Urgent",
		);
	});
	it("Docs → Low", () => {
		expect(assignPriority("Docs", "update README")).toBe("Low");
	});
	it("Feature → Normal", () => {
		expect(assignPriority("Feature", "add billing portal")).toBe("Normal");
	});
	it("Revert → High", () => {
		expect(assignPriority("Revert", "rollback DB change")).toBe("High");
	});
	it("priorityToCu maps to ClickUp 1..4", () => {
		expect(priorityToCu("Urgent")).toBe(1);
		expect(priorityToCu("High")).toBe(2);
		expect(priorityToCu("Normal")).toBe(3);
		expect(priorityToCu("Low")).toBe(4);
	});
});

describe("classifyEpic (BGMT KEYWORD_CLUSTERS scoring)", () => {
	it("matches Authentication & Security on auth keywords", () => {
		expect(classifyEpic("rotate JWT keys with CSRF protection")).toBe(
			"Authentication & Security",
		);
	});
	it("matches Database on schema keywords", () => {
		expect(classifyEpic("add new postgresql migration for orders")).toBe(
			"Database",
		);
	});
	it("falls back to General Development for unmatched text", () => {
		expect(classifyEpic("misc tweak nothing notable")).toBe(
			"General Development",
		);
	});
	it("returns the highest-scoring cluster on ties-by-overlap", () => {
		// 'docker' alone matches Deployment & DevOps; 'docker railway dockerfile'
		// gives 3 hits and should still resolve to that cluster.
		expect(classifyEpic("docker railway dockerfile cleanup")).toBe(
			"Deployment & DevOps",
		);
	});
	it("constants are non-empty and well-typed", () => {
		expect(Object.keys(KEYWORD_CLUSTERS).length).toBeGreaterThan(15);
		expect(Object.keys(TAG_KEYWORDS).length).toBeGreaterThan(5);
	});
});

describe("deriveTags", () => {
	it("emits BGMT tags from subject keywords plus type/source/epic", () => {
		const tags = deriveTags({
			subject: "feat(auth): add JWT rotation",
			body: "",
			files: ["src/auth.ts"],
			type: "Feature",
			source: "claude-code",
			epic: "Authentication & Security",
		});
		expect(tags).toEqual(
			expect.arrayContaining([
				"security",
				"type:feature",
				"source:claude-code",
				"epic:authentication-security",
			]),
		);
	});

	it("file-path heuristic adds frontend tag", () => {
		const tags = deriveTags({
			subject: "tweak header",
			files: ["src/components/Header.tsx"],
			type: "Style",
			source: "human",
			epic: "UI/UX Design",
		});
		expect(tags).toContain("frontend");
	});

	it("falls back to general when no keyword matches", () => {
		const tags = deriveTags({
			subject: "nothing relevant here",
			files: [],
			type: "Chore",
			source: "human",
			epic: "General Development",
		});
		expect(tags).toContain("general");
	});
});

describe("estimateMinutes", () => {
	it("returns base 30 min for tiny commits", () => {
		expect(estimateMinutes(1, 5, "Chore")).toBe(30);
	});
	it("scales modestly with LOC delta", () => {
		const m = estimateMinutes(3, 200, "Feature"); // 4 buckets of 50 = 40 min bonus
		expect(m).toBeGreaterThan(30);
		expect(m).toBeLessThanOrEqual(30 + 210 + 60);
	});
	it("caps at 4 h", () => {
		expect(estimateMinutes(100, 100_000, "Feature")).toBeLessThanOrEqual(
			30 + 210 + 60,
		);
	});
});

describe("normalizeAuthor", () => {
	it("AUTHOR_MAP entry wins over raw email", () => {
		expect(normalizeAuthor("bazigards@proton.me")).toBe(
			"achrafalaoui14@gmail.com",
		);
	});
	it("project-level override wins over default map", () => {
		expect(
			normalizeAuthor("noreply@anthropic.com", {
				"noreply@anthropic.com": "ai-bot@example.org",
			}),
		).toBe("ai-bot@example.org");
	});
	it("unknown email is lowercased and returned", () => {
		expect(normalizeAuthor("Random@Example.COM")).toBe("random@example.com");
	});
	it("empty input returns empty string", () => {
		expect(normalizeAuthor("")).toBe("");
	});
	it("ported AUTHOR_MAP contains the canonical 5 entries", () => {
		expect(Object.keys(AUTHOR_MAP).length).toBe(5);
	});
});

describe("classifyArtifact (Plan §C.5)", () => {
	it.each<[string, string]>([
		// adr
		["docs/adr/0001-use-postgres.md", "adr"],
		["docs/adrs/0042-rename.mdx", "adr"],
		["packages/foo/adr/0007-thing.md", "adr"],
		["ARCHITECTURE.md", "adr"],
		// doc
		["README.md", "doc"],
		["CHANGELOG", "doc"],
		["docs/getting-started.md", "doc"],
		["docs/api/v1.rst", "doc"],
		// infra
		["Dockerfile", "infra"],
		["Dockerfile.prod", "infra"],
		["docker-compose.yml", "infra"],
		["docker-compose.staging.yaml", "infra"],
		[".github/workflows/ci.yml", "infra"],
		["terraform/vpc.tf", "infra"],
		["k8s/deploy.yaml", "infra"],
		["Makefile", "infra"],
		// dependency
		["package.json", "dependency"],
		["pyproject.toml", "dependency"],
		["Cargo.toml", "dependency"],
		["go.mod", "dependency"],
		["requirements.txt", "dependency"],
		["requirements-dev.txt", "dependency"],
		// config-schema
		[".env.example", "config-schema"],
		["config/app.example", "config-schema"],
		["schemas/user.schema.json", "config-schema"],
		// submodule
		[".gitmodules", "submodule"],
		// generated suppression
		["dist/index.js", "generated"],
		["node_modules/foo/index.js", "generated"],
		[".next/server/page.js", "generated"],
		["coverage/lcov.info", "generated"],
		["yarn.lock", "generated"],
		["package-lock.json", "generated"],
		["pnpm-lock.yaml", "generated"],
		["go.sum", "generated"],
		// binary by extension
		["assets/logo.png", "binary-resource"],
		["docs/diagram.pdf", "binary-resource"],
		["fonts/inter.woff2", "binary-resource"],
		// code (fallthrough)
		["src/api.ts", "code"],
		["lib/foo.py", "code"],
		["pkg/foo/bar.go", "code"],
	])("classifies %s as %s", (path, expected) => {
		expect(classifyArtifact(path)).toBe(expected);
	});

	it("treats files >100KB without recognised extension as binary-resource", () => {
		expect(classifyArtifact("data/blob.bin", undefined, 250_000)).toBe(
			"binary-resource",
		);
	});

	it("does not treat 50KB code files as binary-resource", () => {
		expect(classifyArtifact("src/big.ts", undefined, 50_000)).toBe("code");
	});
});

describe("normaliseFileStatus", () => {
	it("accepts both short codes and DTO long names", () => {
		expect(normaliseFileStatus("A")).toBe("A");
		expect(normaliseFileStatus("added")).toBe("A");
		expect(normaliseFileStatus("M")).toBe("M");
		expect(normaliseFileStatus("modified")).toBe("M");
		expect(normaliseFileStatus("D")).toBe("D");
		expect(normaliseFileStatus("deleted")).toBe("D");
		expect(normaliseFileStatus("R")).toBe("R");
		expect(normaliseFileStatus("R100")).toBe("R");
		expect(normaliseFileStatus("renamed")).toBe("R");
	});
	it("returns null for empty / unrecognised", () => {
		expect(normaliseFileStatus(undefined)).toBeNull();
		expect(normaliseFileStatus("")).toBeNull();
		expect(normaliseFileStatus("X")).toBeNull();
	});
});
