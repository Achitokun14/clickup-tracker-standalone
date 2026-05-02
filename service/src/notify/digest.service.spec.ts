import { optOutSet } from "./digest.service";

describe("optOutSet", () => {
	it("returns empty set for null/empty config", () => {
		expect(optOutSet(null).size).toBe(0);
		expect(optOutSet({}).size).toBe(0);
	});

	it("collects only members with notification_opt_out=true (lowercased)", () => {
		const set = optOutSet({
			members: {
				"Alice@x.com": { notification_opt_out: true },
				"bob@x.com": { notification_opt_out: false },
				"CAROL@X.COM": { notification_opt_out: true },
			},
		});
		expect(set.has("alice@x.com")).toBe(true);
		expect(set.has("bob@x.com")).toBe(false);
		expect(set.has("carol@x.com")).toBe(true);
		expect(set.size).toBe(2);
	});

	it("ignores members entries that aren't objects", () => {
		const set = optOutSet({ members: { weird: "not an object" } as any });
		expect(set.size).toBe(0);
	});
});
