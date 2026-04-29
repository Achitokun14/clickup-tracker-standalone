import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { ClickUpHmacGuard } from "./clickup-hmac.guard";

class FakePrisma {
	constructor(private secret: string | null) {}
	async $queryRawUnsafe<T>(): Promise<T> {
		return [{ webhook_secret: this.secret }] as unknown as T;
	}
}

function makeCtx(opts: {
	signature?: string;
	rawBody?: Buffer;
	body?: unknown;
}): ExecutionContext {
	const req: any = {
		headers: opts.signature ? { "x-signature": opts.signature } : {},
		rawBody: opts.rawBody,
		body: opts.body ?? {},
	};
	return {
		switchToHttp: () => ({ getRequest: () => req }),
	} as unknown as ExecutionContext;
}

describe("ClickUpHmacGuard", () => {
	const secret = "deadbeef-secret";
	const body = { team_id: "TEAM1", event: "taskUpdated" };
	const raw = Buffer.from(JSON.stringify(body));
	const goodSig = createHmac("sha256", secret).update(raw).digest("hex");

	it("accepts a valid signature", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(secret) as any);
		const ctx = makeCtx({ signature: goodSig, rawBody: raw, body });
		await expect(guard.canActivate(ctx)).resolves.toBe(true);
	});

	it("rejects when signature is missing", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(secret) as any);
		const ctx = makeCtx({ rawBody: raw, body });
		await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});

	it("rejects when raw body is missing", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(secret) as any);
		const ctx = makeCtx({ signature: goodSig, body });
		await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});

	it("rejects when team has no registered secret", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(null) as any);
		const ctx = makeCtx({ signature: goodSig, rawBody: raw, body });
		await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});

	it("rejects on signature mismatch", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(secret) as any);
		const tampered = createHmac("sha256", "wrong-secret")
			.update(raw)
			.digest("hex");
		const ctx = makeCtx({ signature: tampered, rawBody: raw, body });
		await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});

	it("rejects when team_id is missing from body", async () => {
		const guard = new ClickUpHmacGuard(new FakePrisma(secret) as any);
		const ctx = makeCtx({
			signature: goodSig,
			rawBody: raw,
			body: { event: "x" },
		});
		await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});
});
