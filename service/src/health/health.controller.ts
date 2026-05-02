import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json") as { version: string };

@Controller("health")
export class HealthController {
	private readonly startTime = Date.now();

	constructor(private readonly prisma: PrismaService) {}

	@Get()
	async check() {
		const checks: Record<string, string> = {};

		try {
			await this.prisma.$queryRaw`SELECT 1`;
			checks.database = "ok";
		} catch {
			checks.database = "error";
		}

		const allOk = Object.values(checks).every((v) => v === "ok");

		// Plan §K — surface optional integration configuration so operators
		// can confirm whether opt-in features are wired up.
		const integrations = {
			github_token: Boolean(process.env.GITHUB_TOKEN),
			smtp: Boolean(process.env.SMTP_HOST),
			slack_webhook: Boolean(process.env.SLACK_WEBHOOK_URL),
			railway_token: Boolean(process.env.RAILWAY_API_TOKEN),
		};

		return {
			status: allOk ? "healthy" : "degraded",
			service: "clickup-tracker",
			version: pkg.version,
			uptime: Math.floor((Date.now() - this.startTime) / 1000),
			checks,
			integrations,
		};
	}
}
