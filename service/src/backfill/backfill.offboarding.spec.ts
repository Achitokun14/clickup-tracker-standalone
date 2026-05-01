import { diffOffboardedEmails } from "./backfill.service";

describe("diffOffboardedEmails (Plan §B.9)", () => {
	it("returns emails present in previous but absent from current", () => {
		const previous = { "ali@example.com": 1, "bob@example.com": 2 };
		const current = { "ali@example.com": 1 };
		expect(diffOffboardedEmails(previous, current)).toEqual([
			"bob@example.com",
		]);
	});

	it("returns empty when no removals", () => {
		const previous = { "ali@example.com": 1 };
		const current = { "ali@example.com": 1, "bob@example.com": 2 };
		expect(diffOffboardedEmails(previous, current)).toEqual([]);
	});

	it("is case-insensitive (ALI@x.com == ali@x.com)", () => {
		const previous = { "ALI@example.com": 1 };
		const current = { "ali@example.com": 1 };
		expect(diffOffboardedEmails(previous, current)).toEqual([]);
	});

	it("tolerates empty previous + empty current", () => {
		expect(diffOffboardedEmails({}, {})).toEqual([]);
		expect(diffOffboardedEmails({}, { "ali@example.com": 1 })).toEqual([]);
		expect(diffOffboardedEmails({ "ali@example.com": 1 }, {})).toEqual([
			"ali@example.com",
		]);
	});

	it("normalises returned emails to lowercase", () => {
		const previous = { "OLD@x.com": 1, "NEW@x.com": 2 };
		const current = { "new@x.com": 2 };
		expect(diffOffboardedEmails(previous, current)).toEqual(["old@x.com"]);
	});
});
