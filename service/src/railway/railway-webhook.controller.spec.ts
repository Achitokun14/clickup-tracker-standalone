import { createHmac } from "node:crypto";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import {
	parseRailwayWebhook,
	RailwayWebhookController,
} from "./railway-webhook.controller";

const SECRET = "rw-secret";

function sign(body: any): string {
	return (
		"sha256=" +
		createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex")
	);
}

class FakePrisma {
	rows: any[];
	constructor(rows: any[]) {
		this.rows = rows;
	}
	async $queryRawUnsafe() {
		return this.rows;
	}
}

class FakeMirror {
	calls: any[] = [];
	async mirror(projectId: string, dep: any) {
		this.calls.push({ projectId, dep });
		return { taskId: "T", created: true, updated: false };
	}
}

function build(opts: { secret?: string; rows?: any[] } = {}) {
	if (opts.secret !== undefined) {
		process.env.RAILWAY_WEBHOOK_SECRET = opts.secret;
	} else {
		delete process.env.RAILWAY_WEBHOOK_SECRET;
	}
	const prisma = new FakePrisma(opts.rows ?? [{ id: "PID" }]);
	const mirror = new FakeMirror();
	const ctrl = new RailwayWebhookController(prisma as any, mirror as any);
	return { ctrl, mirror };
}

const validBody = {
	deployment: {
		id: "dep-1",
		status: "SUCCESS",
		serviceId: "svc-1",
		environmentName: "production",
		commitSha: "abc1234",
		createdAt: "2026-05-02T10:14:00Z",
		finishedAt: "2026-05-02T10:17:00Z",
	},
};

describe("RailwayWebhookController", () => {
	afterEach(() => {
		delete process.env.RAILWAY_WEBHOOK_SECRET;
	});

	it("400 on missing body", async () => {
		const { ctrl } = build();
		await expect(
			ctrl.ingest("PID", undefined, undefined as any),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("401 when project does not exist", async () => {
		const { ctrl } = build({ rows: [] });
		await expect(
			ctrl.ingest("PID", undefined, validBody),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("HMAC enforced when secret configured", async () => {
		const { ctrl } = build({ secret: SECRET });
		await expect(
			ctrl.ingest("PID", "sha256=" + "0".repeat(64), validBody),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("dispatches to mirror when secret matches", async () => {
		const { ctrl, mirror } = build({ secret: SECRET });
		await ctrl.ingest("PID", sign(validBody), validBody);
		expect(mirror.calls).toHaveLength(1);
		expect(mirror.calls[0].dep.id).toBe("dep-1");
		expect(mirror.calls[0].dep.environmentName).toBe("production");
	});

	it("dispatches with no secret when env var unset", async () => {
		const { ctrl, mirror } = build();
		await ctrl.ingest("PID", undefined, validBody);
		expect(mirror.calls).toHaveLength(1);
	});

	it("ignores unrecognised payloads silently (no throw, no dispatch)", async () => {
		const { ctrl, mirror } = build();
		await ctrl.ingest("PID", undefined, { ping: true });
		expect(mirror.calls).toHaveLength(0);
	});
});

describe("parseRailwayWebhook", () => {
	it("normalises snake_case + camelCase fields", () => {
		const dep = parseRailwayWebhook({
			deployment: {
				id: "x",
				status: "SUCCESS",
				service_id: "s1",
				environment: "production",
				commit_sha: "abc",
				created_at: "2026-05-02T10:14:00Z",
				updatedAt: "2026-05-02T10:17:00Z",
				url: "https://x.app",
			},
		});
		expect(dep).not.toBeNull();
		expect(dep!.id).toBe("x");
		expect(dep!.serviceId).toBe("s1");
		expect(dep!.environmentName).toBe("production");
		expect(dep!.commitSha).toBe("abc");
		// terminal status auto-fills finishedAt from updatedAt
		expect(dep!.finishedAt).toBe("2026-05-02T10:17:00Z");
		expect(dep!.staticUrl).toBe("https://x.app");
	});

	it("returns null on missing id/status", () => {
		expect(parseRailwayWebhook({ deployment: {} })).toBeNull();
		expect(parseRailwayWebhook({ ping: true })).toBeNull();
	});
});
