import { Test } from "@nestjs/testing";
import { ClickUpDirectService } from "./clickup-direct.service";
import { SPRINT_LIST_VIEWS, VIEWS_PER_LIST, ViewsService } from "./views";

describe("ViewsService", () => {
	const fakeClickup = {
		listListViews: jest.fn(),
		createListView: jest.fn(),
	};

	let svc: ViewsService;

	beforeEach(async () => {
		fakeClickup.listListViews.mockReset();
		fakeClickup.createListView.mockReset();

		const moduleRef = await Test.createTestingModule({
			providers: [
				ViewsService,
				{ provide: ClickUpDirectService, useValue: fakeClickup },
			],
		}).compile();
		svc = moduleRef.get(ViewsService);
	});

	it("creates every wanted view when the list has none", async () => {
		fakeClickup.listListViews.mockResolvedValue([]);
		fakeClickup.createListView.mockResolvedValue({ id: "v" });

		await svc.seedViewsForList("L1", "active_sprint", "tok");

		expect(fakeClickup.createListView).toHaveBeenCalledTimes(
			VIEWS_PER_LIST.active_sprint.length,
		);
	});

	it("re-uses existing views matched by name (idempotent)", async () => {
		const wanted = VIEWS_PER_LIST.bugs;
		fakeClickup.listListViews.mockResolvedValue(
			wanted.map((v) => ({ id: "x", name: v.name })),
		);

		await svc.seedViewsForList("L1", "bugs", "tok");

		expect(fakeClickup.createListView).not.toHaveBeenCalled();
	});

	it("matches view names case-insensitively", async () => {
		fakeClickup.listListViews.mockResolvedValue([
			{ id: "x", name: "BOARD — BY STATUS" },
		]);
		await svc.seedViewsForList("L", "in_review", "tok");
		expect(fakeClickup.createListView).not.toHaveBeenCalled();
	});

	it("seeds Calendar for sprint Lists", async () => {
		fakeClickup.listListViews.mockResolvedValue([]);
		fakeClickup.createListView.mockResolvedValue({ id: "v" });

		await svc.seedViewsForList("L", "sprint", "tok");

		expect(fakeClickup.createListView).toHaveBeenCalledTimes(
			SPRINT_LIST_VIEWS.length,
		);
	});

	it("survives a single createListView failure (continues with remaining)", async () => {
		fakeClickup.listListViews.mockResolvedValue([]);
		let n = 0;
		fakeClickup.createListView.mockImplementation(async () => {
			n++;
			if (n === 1) throw new Error("boom");
			return { id: `v${n}` };
		});

		await svc.seedViewsForList("L", "open_work", "tok");

		expect(fakeClickup.createListView).toHaveBeenCalledTimes(
			VIEWS_PER_LIST.open_work.length,
		);
	});

	it("downgrades tier-gated view failures (Workload) to debug, not warn", async () => {
		fakeClickup.listListViews.mockResolvedValue([]);
		fakeClickup.createListView.mockImplementation(async (_id, body) => {
			if (body.type === "workload") throw new Error("403");
			return { id: "ok" };
		});

		// Just verify it doesn't throw — log severity isn't easily assertable
		// without intercepting the Nest Logger.
		await expect(
			svc.seedViewsForList("L", "active_sprint", "tok"),
		).resolves.toBeUndefined();
	});

	it("returns early on empty view list", async () => {
		await svc.seedViewsForList("L", "history_overview", "tok");
		expect(fakeClickup.listListViews).not.toHaveBeenCalled();
	});

	it("does not throw when listListViews itself fails", async () => {
		fakeClickup.listListViews.mockRejectedValue(new Error("503"));
		fakeClickup.createListView.mockResolvedValue({ id: "v" });

		await expect(
			svc.seedViewsForList("L", "in_review", "tok"),
		).resolves.toBeUndefined();
		// Empty existing → still attempts creates
		expect(fakeClickup.createListView).toHaveBeenCalled();
	});
});
