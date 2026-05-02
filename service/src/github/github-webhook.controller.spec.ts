import { createHmac } from "node:crypto";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { GithubWebhookController } from "./github-webhook.controller";

const SECRET = "test-secret";

function sign(body: any): string {
	return (
		"sha256=" +
		createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex")
	);
}

class FakePrisma {
	rows: any[];
	inserted = 0;
	insertReturn = 1;
	constructor(rows: any[]) {
		this.rows = rows;
	}
	async $queryRawUnsafe() {
		return this.rows;
	}
	async $executeRawUnsafe() {
		this.inserted += 1;
		return this.insertReturn;
	}
}

class FakeReviewEvents {
	calls: any[] = [];
	async record(input: any) {
		this.calls.push(input);
		return { inserted: true };
	}
}

function build(opts: { secret?: string | null }) {
	// Explicitly distinguish "use default secret" (key absent) from
	// "force null" (key present with null value).
	const secretValue =
		"secret" in opts ? (opts.secret as string | null) : SECRET;
	const prisma = new FakePrisma([
		{ id: "PID", github_webhook_secret: secretValue },
	]);
	const reviewEvents = new FakeReviewEvents();
	const actionsMirror = {
		recordRun: jest.fn(),
		recordPrOpened: jest.fn(),
		recordPrClosed: jest.fn(),
	};
	const ctrl = new GithubWebhookController(
		prisma as any,
		reviewEvents as any,
		actionsMirror as any,
	);
	return { ctrl, prisma, reviewEvents, actionsMirror };
}

describe("GithubWebhookController", () => {
	const validBody = {
		review: {
			user: { login: "alice" },
			state: "approved",
			submitted_at: "2026-05-02T10:00:00Z",
		},
		pull_request: {
			number: 7,
			created_at: "2026-05-02T08:00:00Z",
			user: { login: "bob" },
		},
	};

	it("400 when GitHub headers missing", async () => {
		const { ctrl } = build({});
		await expect(
			ctrl.ingest("PID", undefined, undefined, undefined, validBody),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("401 when project has no webhook secret", async () => {
		const { ctrl } = build({ secret: null });
		await expect(
			ctrl.ingest(
				"PID",
				sign(validBody),
				"pull_request_review",
				"d-1",
				validBody,
			),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("401 on HMAC mismatch", async () => {
		const { ctrl } = build({});
		await expect(
			ctrl.ingest(
				"PID",
				"sha256=" + "0".repeat(64),
				"pull_request_review",
				"d-1",
				validBody,
			),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("dispatches pull_request_review.submitted to ReviewEventsService", async () => {
		const { ctrl, reviewEvents } = build({});
		await ctrl.ingest(
			"PID",
			sign(validBody),
			"pull_request_review",
			"d-1",
			validBody,
		);
		expect(reviewEvents.calls).toHaveLength(1);
		expect(reviewEvents.calls[0]).toMatchObject({
			projectId: "PID",
			prNumber: 7,
			reviewerLogin: "alice",
			state: "approved",
			prAuthorLogin: "bob",
		});
	});

	it("dedupes a re-delivery (no second dispatch)", async () => {
		const { ctrl, prisma, reviewEvents } = build({});
		// Simulate ON CONFLICT returning 0 rows.
		(prisma as any).insertReturn = 0;
		await ctrl.ingest(
			"PID",
			sign(validBody),
			"pull_request_review",
			"d-1",
			validBody,
		);
		expect(reviewEvents.calls).toHaveLength(0);
	});

	it("accepts unknown event types as no-op (still 204) so GitHub doesn't disable webhook", async () => {
		const { ctrl, reviewEvents } = build({});
		const otherBody = { action: "ping" };
		await ctrl.ingest("PID", sign(otherBody), "ping", "d-2", otherBody);
		expect(reviewEvents.calls).toHaveLength(0);
	});
});
