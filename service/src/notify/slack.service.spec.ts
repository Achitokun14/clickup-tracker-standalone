import { SlackService } from "./slack.service";

describe("SlackService", () => {
	const ORIGINAL_URL = process.env.SLACK_WEBHOOK_URL;
	const fetchSpy = jest.spyOn(globalThis as any, "fetch");

	beforeEach(() => {
		fetchSpy.mockReset();
	});

	afterAll(() => {
		if (ORIGINAL_URL) process.env.SLACK_WEBHOOK_URL = ORIGINAL_URL;
		else delete process.env.SLACK_WEBHOOK_URL;
		fetchSpy.mockRestore();
	});

	it("configured() reflects SLACK_WEBHOOK_URL env", () => {
		const svc = new SlackService();
		delete process.env.SLACK_WEBHOOK_URL;
		expect(svc.configured()).toBe(false);
		process.env.SLACK_WEBHOOK_URL = "https://hooks.slack/x";
		expect(svc.configured()).toBe(true);
	});

	it("postSprintPlan no-ops when env unset (posted=false, no fetch)", async () => {
		delete process.env.SLACK_WEBHOOK_URL;
		const svc = new SlackService();
		const out = await svc.postSprintPlan({
			projectName: "alpha",
			isoWeek: "2026-W17",
			goal: "ship Foo",
			taskCount: 5,
		});
		expect(out.posted).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts JSON {text, channel} when env set + 200 OK", async () => {
		process.env.SLACK_WEBHOOK_URL = "https://hooks.slack/x";
		fetchSpy.mockResolvedValue({ ok: true, status: 200 } as any);
		const svc = new SlackService();
		const out = await svc.postCriticalBug({
			projectName: "alpha",
			taskName: "BUG-7",
			taskUrl: "https://app.clickup.com/t/BUG-7",
			channel: "#bugs",
		});
		expect(out.posted).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body as string);
		expect(body.text).toContain(":rotating_light:");
		expect(body.text).toContain("BUG-7");
		expect(body.channel).toBe("#bugs");
	});

	it("returns posted=false on non-2xx", async () => {
		process.env.SLACK_WEBHOOK_URL = "https://hooks.slack/x";
		fetchSpy.mockResolvedValue({ ok: false, status: 500 } as any);
		const svc = new SlackService();
		const out = await svc.postRetroSummary({
			projectName: "alpha",
			isoWeek: "2026-W17",
			delivered: 8,
			committed: 10,
		});
		expect(out.posted).toBe(false);
	});

	it("survives transport errors gracefully", async () => {
		process.env.SLACK_WEBHOOK_URL = "https://hooks.slack/x";
		fetchSpy.mockRejectedValue(new Error("ECONNRESET"));
		const svc = new SlackService();
		const out = await svc.postSprintPlan({
			projectName: "alpha",
			isoWeek: "2026-W17",
			goal: "x",
			taskCount: 0,
		});
		expect(out.posted).toBe(false);
	});
});
