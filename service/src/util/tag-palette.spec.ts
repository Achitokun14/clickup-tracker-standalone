import { tagPalette } from "./tag-palette";

describe("tagPalette", () => {
	it("returns blue for epic:* tags", () => {
		expect(tagPalette("epic:api-backend")).toEqual({
			fg: "#FFFFFF",
			bg: "#3B82F6",
		});
	});

	it("returns red for severity:critical", () => {
		expect(tagPalette("severity:critical").bg).toBe("#DC2626");
	});

	it("graduates severity colors high → orange, medium → yellow, low → green", () => {
		expect(tagPalette("severity:high").bg).toBe("#EA580C");
		expect(tagPalette("severity:medium").bg).toBe("#FBBF24");
		expect(tagPalette("severity:low").bg).toBe("#10B981");
	});

	it("colors type:feat / type:fix / type:chore distinctly", () => {
		const feat = tagPalette("type:feat");
		const fix = tagPalette("type:fix");
		const chore = tagPalette("type:chore");
		expect(feat.bg).not.toBe(fix.bg);
		expect(feat.bg).not.toBe(chore.bg);
		expect(fix.bg).not.toBe(chore.bg);
	});

	it("falls through unknown tags to neutral default", () => {
		expect(tagPalette("totally-unknown-tag")).toEqual({
			fg: "#000000",
			bg: "#E5E7EB",
		});
	});

	it("is case-insensitive on tag input", () => {
		expect(tagPalette("EPIC:Foo")).toEqual(tagPalette("epic:foo"));
	});

	it("handles empty / null-ish input without throwing", () => {
		expect(() => tagPalette("")).not.toThrow();
		expect(() => tagPalette(undefined as unknown as string)).not.toThrow();
	});
});
