import {
	ReviewerSuggesterService,
	renderSuggestedReviewersMd,
} from "./reviewer-suggester";

describe("ReviewerSuggesterService.suggestForFiles", () => {
	const fakeOwnership = {
		topOwnersForPath: jest.fn(),
	};
	const svc = new ReviewerSuggesterService(fakeOwnership as any);

	beforeEach(() => fakeOwnership.topOwnersForPath.mockReset());

	it("returns top-N owners across all touched files, sorted by tally", async () => {
		fakeOwnership.topOwnersForPath
			.mockResolvedValueOnce([
				{ email: "alice@x.com", score: 100, lastTouchedAt: null, commits: 1 },
				{ email: "bob@x.com", score: 60, lastTouchedAt: null, commits: 1 },
			])
			.mockResolvedValueOnce([
				{ email: "alice@x.com", score: 50, lastTouchedAt: null, commits: 1 },
				{ email: "carol@x.com", score: 40, lastTouchedAt: null, commits: 1 },
			]);
		const out = await svc.suggestForFiles("PID", ["a.ts", "b.ts"]);
		expect(out.map((o) => o.email)).toEqual([
			"alice@x.com",
			"bob@x.com",
			"carol@x.com",
		]);
		expect(out[0].score).toBe(150); // 100 + 50
	});

	it("excludes the PR author by email (case insensitive)", async () => {
		fakeOwnership.topOwnersForPath.mockResolvedValueOnce([
			{ email: "alice@x.com", score: 100, lastTouchedAt: null, commits: 1 },
			{ email: "bob@x.com", score: 50, lastTouchedAt: null, commits: 1 },
		]);
		const out = await svc.suggestForFiles("PID", ["a.ts"], {
			excludeEmail: "ALICE@X.com",
		});
		expect(out.map((o) => o.email)).toEqual(["bob@x.com"]);
	});

	it("respects topN", async () => {
		fakeOwnership.topOwnersForPath.mockResolvedValueOnce([
			{ email: "a@x", score: 30, lastTouchedAt: null, commits: 1 },
			{ email: "b@x", score: 20, lastTouchedAt: null, commits: 1 },
			{ email: "c@x", score: 10, lastTouchedAt: null, commits: 1 },
		]);
		const out = await svc.suggestForFiles("PID", ["a.ts"], { topN: 2 });
		expect(out).toHaveLength(2);
	});

	it("survives an ownership query error and continues with remaining files", async () => {
		fakeOwnership.topOwnersForPath
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce([
				{ email: "carol@x.com", score: 40, lastTouchedAt: null, commits: 1 },
			]);
		const out = await svc.suggestForFiles("PID", ["bad.ts", "good.ts"]);
		expect(out).toEqual([{ email: "carol@x.com", score: 40 }]);
	});
});

describe("renderSuggestedReviewersMd", () => {
	it("returns empty string for no suggestions", () => {
		expect(renderSuggestedReviewersMd([])).toBe("");
	});

	it("renders comma-joined inline-code emails", () => {
		expect(
			renderSuggestedReviewersMd([
				{ email: "alice@x.com", score: 100 },
				{ email: "bob@x.com", score: 60 },
			]),
		).toBe("**Suggested reviewers:** `alice@x.com`, `bob@x.com`");
	});
});
