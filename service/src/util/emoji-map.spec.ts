import {
	emojiForArtifact,
	emojiForBugSeverity,
	emojiForCommitType,
	prefixName,
} from "./emoji-map";

describe("emojiForCommitType", () => {
	it("maps feat → ✨, fix → 🐛, chore → 🔧, docs → 📝, refactor → ♻️", () => {
		expect(emojiForCommitType("feat")).toBe("✨");
		expect(emojiForCommitType("fix")).toBe("🐛");
		expect(emojiForCommitType("chore")).toBe("🔧");
		expect(emojiForCommitType("docs")).toBe("📝");
		expect(emojiForCommitType("refactor")).toBe("♻️");
	});

	it("normalises case", () => {
		expect(emojiForCommitType("FEAT")).toBe("✨");
		expect(emojiForCommitType("Fix")).toBe("🐛");
	});

	it("returns empty string on unknown / undefined", () => {
		expect(emojiForCommitType(undefined)).toBe("");
		expect(emojiForCommitType("wat")).toBe("");
	});
});

describe("emojiForBugSeverity", () => {
	it("maps critical → 🚨, high → 🟧, medium → 🟨, low → 🟢", () => {
		expect(emojiForBugSeverity("critical")).toBe("🚨");
		expect(emojiForBugSeverity("high")).toBe("🟧");
		expect(emojiForBugSeverity("medium")).toBe("🟨");
		expect(emojiForBugSeverity("low")).toBe("🟢");
	});

	it("returns empty string on unknown", () => {
		expect(emojiForBugSeverity(undefined)).toBe("");
		expect(emojiForBugSeverity("super-bad")).toBe("");
	});
});

describe("emojiForArtifact", () => {
	it("maps hotspot → 🔥, module → 📂, deps → 📦, deployment → 🚀", () => {
		expect(emojiForArtifact("hotspot")).toBe("🔥");
		expect(emojiForArtifact("module")).toBe("📂");
		expect(emojiForArtifact("deps")).toBe("📦");
		expect(emojiForArtifact("deployment")).toBe("🚀");
	});
});

describe("prefixName", () => {
	it("prefixes when emoji is non-empty", () => {
		expect(prefixName("✨", "feat(api): add Foo")).toBe(
			"✨ feat(api): add Foo",
		);
	});

	it("returns body unchanged when emoji is empty", () => {
		expect(prefixName("", "no prefix here")).toBe("no prefix here");
	});
});
