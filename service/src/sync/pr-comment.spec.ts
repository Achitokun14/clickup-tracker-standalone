import { classifyPrComment, extractCommentText } from "./sync.service";

describe("classifyPrComment (Plan §C.3)", () => {
	it("matches `PR opened`", () => {
		expect(classifyPrComment("PR opened: #42")).toBe("open");
	});
	it("matches `PR created`", () => {
		expect(
			classifyPrComment("PR created — see github.com/foo/bar/pull/7"),
		).toBe("open");
	});
	it("matches `Pull request opened`", () => {
		expect(classifyPrComment("Pull request opened by alice")).toBe("open");
	});
	it("matches `opened pull request` (verb-first)", () => {
		expect(classifyPrComment("alice opened pull request #7")).toBe("open");
	});
	it("matches `PR merged` (case-insensitive)", () => {
		expect(classifyPrComment("PR merged into main")).toBe("merged");
		expect(classifyPrComment("pr MERGED")).toBe("merged");
	});
	it("matches `merged pull request`", () => {
		expect(classifyPrComment("alice merged pull request #7")).toBe("merged");
	});
	it("merged outranks open when both phrases appear", () => {
		// Realistic: a bot summary like "alice opened pull request #7 — PR merged"
		// must close, not just tag pr-open.
		expect(classifyPrComment("alice opened pull request #7 — PR merged")).toBe(
			"merged",
		);
	});
	it("returns 'none' for unrelated text", () => {
		expect(classifyPrComment("ship it")).toBe("none");
		expect(classifyPrComment("")).toBe("none");
		expect(
			classifyPrComment("the team merged the cells in the spreadsheet"),
		).toBe("none");
	});
});

describe("extractCommentText (Plan §C.3)", () => {
	it("returns p.comment_text when present", () => {
		expect(extractCommentText({ comment_text: "hello" })).toBe("hello");
	});
	it("falls back to p.comment.text", () => {
		expect(extractCommentText({ comment: { text: "PR opened" } })).toBe(
			"PR opened",
		);
	});
	it("falls back to p.history_items[0].comment.text", () => {
		expect(
			extractCommentText({
				history_items: [{ comment: { text: "PR merged" } }],
			}),
		).toBe("PR merged");
	});
	it("returns empty string for missing/non-object payloads", () => {
		expect(extractCommentText(null)).toBe("");
		expect(extractCommentText(undefined)).toBe("");
		expect(extractCommentText({})).toBe("");
		expect(extractCommentText("a string")).toBe("");
	});
	it("trims whitespace", () => {
		expect(extractCommentText({ comment_text: "  hello  " })).toBe("hello");
	});
});
