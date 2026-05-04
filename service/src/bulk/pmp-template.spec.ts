import {
	PMP_LIST_STATUSES,
	PMP_TEMPLATE,
	renderPmpMarkdown,
} from "./pmp-template";

describe("PMP_TEMPLATE", () => {
	it("contains exactly 19 charter sections", () => {
		expect(PMP_TEMPLATE).toHaveLength(19);
	});

	it("uses unique stable keys (so task_index keys never collide)", () => {
		const keys = PMP_TEMPLATE.map((t) => t.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("matches CSV status distribution: 4 complete · 6 in progress · 9 to do", () => {
		const buckets = { complete: 0, "in progress": 0, "to do": 0 };
		for (const t of PMP_TEMPLATE) buckets[t.status] += 1;
		expect(buckets).toEqual({ complete: 4, "in progress": 6, "to do": 9 });
	});

	it("every initial status is present in PMP_LIST_STATUSES", () => {
		const allowed = new Set(PMP_LIST_STATUSES.map((s) => s.status));
		for (const t of PMP_TEMPLATE) {
			expect(allowed.has(t.status)).toBe(true);
		}
	});
});

describe("renderPmpMarkdown", () => {
	const sample = PMP_TEMPLATE.find((t) => t.key === "scope_management")!;

	it("substitutes the project's display name into the header", () => {
		const md = renderPmpMarkdown(sample, "Acme Tracker");
		expect(md).toContain("# Acme Tracker — Scope Management");
		expect(md).not.toContain("ELECTRONIC SHOPPING SYSTEM");
	});

	it("falls back to 'Project' when displayName is empty", () => {
		const md = renderPmpMarkdown(sample, "   ");
		expect(md).toContain("# Project — Scope Management");
	});

	it("wraps `[Insert ...]` placeholders in operator-action blockquotes", () => {
		const md = renderPmpMarkdown(sample, "Acme");
		expect(md).toContain("> _Operator action: Insert the project's");
	});

	it("appends the auto-managed footer", () => {
		const md = renderPmpMarkdown(sample, "Acme");
		expect(
			md
				.trim()
				.endsWith("_Auto-managed by clickup-tracker (Project Plan template)._"),
		).toBe(true);
	});

	it("strips smart quotes + non-breaking spaces from the body", () => {
		const fake = {
			...sample,
			body: "Smart quote: “hi” ‘there’",
		};
		const md = renderPmpMarkdown(fake, "Acme");
		expect(md).not.toMatch(/[ “”‘’]/);
		expect(md).toContain('"hi"');
		expect(md).toContain("'there'");
	});
});
