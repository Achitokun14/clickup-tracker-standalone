import { parseCoAuthors } from "./co-author-parse";

describe("parseCoAuthors", () => {
	it("returns [] on null/empty body", () => {
		expect(parseCoAuthors(null)).toEqual([]);
		expect(parseCoAuthors("")).toEqual([]);
	});

	it("extracts a single Co-authored-by trailer", () => {
		const body = "feat(api): add Foo\n\nCo-authored-by: Bob <bob@x.com>";
		expect(parseCoAuthors(body)).toEqual([{ name: "Bob", email: "bob@x.com" }]);
	});

	it("extracts multiple co-authors and lowercases emails", () => {
		const body = [
			"feat: pair work",
			"",
			"Co-authored-by: Alice <ALICE@X.COM>",
			"Co-authored-by: Bob <Bob@X.com>",
		].join("\n");
		expect(parseCoAuthors(body)).toEqual([
			{ name: "Alice", email: "alice@x.com" },
			{ name: "Bob", email: "bob@x.com" },
		]);
	});

	it("dedupes case-variant duplicates of the same email", () => {
		const body = [
			"Co-authored-by: Bob <bob@x.com>",
			"Co-authored-by: BOB <BOB@X.COM>",
		].join("\n");
		expect(parseCoAuthors(body)).toEqual([{ name: "Bob", email: "bob@x.com" }]);
	});

	it("ignores lines that aren't trailers", () => {
		const body = [
			"feat: thing",
			"",
			"This commit was made with co-authored-by something or other",
			"Co-authored-by: Real <real@x>",
		].join("\n");
		expect(parseCoAuthors(body)).toEqual([{ name: "Real", email: "real@x" }]);
	});

	it("tolerates whitespace + case variation in trailer key", () => {
		const body = "  CO-AUTHORED-BY:    Carol   <  carol@x.com  >  ";
		expect(parseCoAuthors(body)).toEqual([
			{ name: "Carol", email: "carol@x.com" },
		]);
	});
});
