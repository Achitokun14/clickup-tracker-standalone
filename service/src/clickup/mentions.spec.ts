import { buildMentionedComment, hasMention } from "./mentions";

describe("buildMentionedComment", () => {
	const members: Record<string, number> = {
		"alice@x.com": 11,
		"bob@x.com": 22,
	};
	const resolve = (e: string) => members[e.toLowerCase()] ?? null;

	it("emits a single text segment when there are no mention tokens", () => {
		const segs = buildMentionedComment("just a plain comment", resolve);
		expect(segs).toEqual([{ text: "just a plain comment" }]);
	});

	it("attaches mention attribute for resolvable emails", () => {
		const segs = buildMentionedComment(
			"hi {@alice@x.com}, please review",
			resolve,
		);
		expect(segs.length).toBe(3);
		expect(segs[0].text).toBe("hi ");
		expect(segs[1].text).toBe("@alice@x.com");
		expect(segs[1].attributes?.mention?.user_id).toBe(11);
		expect(segs[2].text).toBe(", please review");
	});

	it("falls back to plain @email text when email does not resolve", () => {
		const segs = buildMentionedComment("ping {@stranger@nope.io}", resolve);
		expect(segs.find((s) => s.text === "@stranger@nope.io")).toBeDefined();
		expect(
			segs.find((s) => s.text === "@stranger@nope.io")?.attributes?.mention,
		).toBeUndefined();
	});

	it("supports multiple mentions in one comment", () => {
		const segs = buildMentionedComment(
			"{@alice@x.com} + {@bob@x.com} please pair",
			resolve,
		);
		const mentions = segs.filter((s) => s.attributes?.mention);
		expect(mentions.length).toBe(2);
		expect(mentions.map((m) => m.attributes?.mention?.user_id).sort()).toEqual([
			11, 22,
		]);
	});

	it("hasMention returns false when nothing resolved", () => {
		const segs = buildMentionedComment("ping {@unknown@x.com}", resolve);
		expect(hasMention(segs)).toBe(false);
	});

	it("hasMention returns true when at least one mention resolved", () => {
		const segs = buildMentionedComment(
			"ping {@alice@x.com} and {@unknown@x.com}",
			resolve,
		);
		expect(hasMention(segs)).toBe(true);
	});

	it("preserves whitespace and punctuation around tokens", () => {
		const segs = buildMentionedComment("  ({@alice@x.com})  ", resolve);
		const joined = segs.map((s) => s.text).join("");
		expect(joined).toBe("  (@alice@x.com)  ");
	});
});
