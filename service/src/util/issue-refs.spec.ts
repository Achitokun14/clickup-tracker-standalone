import { extractIssueRefs } from "./issue-refs";

describe("extractIssueRefs", () => {
	it("returns [] on null/empty", () => {
		expect(extractIssueRefs(null)).toEqual([]);
		expect(extractIssueRefs("")).toEqual([]);
	});

	it("extracts a local #123 reference", () => {
		const out = extractIssueRefs("fix(api): close #123");
		expect(out).toEqual([{ kind: "local", raw: "#123", number: "123" }]);
	});

	it("extracts GH-prefixed local refs", () => {
		const out = extractIssueRefs("Refs GH-7 in the changelog");
		expect(out).toEqual([{ kind: "local", raw: "GH-7", number: "7" }]);
	});

	it("extracts cross-repo owner/repo#NN", () => {
		const out = extractIssueRefs("see Achitokun14/foo-bar#42 for context");
		expect(out).toEqual([
			{
				kind: "gh-cross-repo",
				raw: "Achitokun14/foo-bar#42",
				ownerRepo: "Achitokun14/foo-bar",
				number: "42",
			},
		]);
	});

	it("does NOT double-count #N inside a cross-repo ref", () => {
		const out = extractIssueRefs("Achitokun14/foo#42 also closes #1");
		const kinds = out.map((r) => r.raw);
		expect(kinds).toContain("Achitokun14/foo#42");
		expect(kinds).toContain("#1");
		// Only one #42 entry (the cross-repo one).
		expect(kinds.filter((r) => r.includes("42"))).toHaveLength(1);
	});

	it("extracts JIRA-style keys (uppercase letters + dash + digits)", () => {
		const out = extractIssueRefs("BUG-7: fix nullpointer; ABC-123: refactor");
		expect(out.map((r) => r.key)).toEqual(["BUG-7", "ABC-123"]);
	});

	it("dedupes duplicate refs in the same message", () => {
		const out = extractIssueRefs("see #7, also #7 again");
		expect(out).toHaveLength(1);
	});

	it("ignores lone words like GH (no number) and bare # without digits", () => {
		const out = extractIssueRefs("GH project conventions; # heading");
		expect(out).toEqual([]);
	});
});
