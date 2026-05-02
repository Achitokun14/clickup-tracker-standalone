import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { ScrumModule } from "../scrum/scrum.module";
import { ActionsMirrorService } from "./actions-mirror.service";
import { GithubPollCron } from "./github-poll.cron";
import { GithubWebhookController } from "./github-webhook.controller";

@Module({
	imports: [ScrumModule],
	controllers: [GithubWebhookController],
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		ActionsMirrorService,
		GithubPollCron,
	],
})
export class GithubModule {}
