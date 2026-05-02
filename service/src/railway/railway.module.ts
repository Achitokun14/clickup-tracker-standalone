import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { ScrumModule } from "../scrum/scrum.module";
import { DeploymentMirrorService } from "./deployment-mirror.service";
import { RailwayPollCron } from "./railway-poll.cron";
import { RailwayWebhookController } from "./railway-webhook.controller";
import { RailwayApiService } from "./railway.service";

@Module({
	imports: [ScrumModule],
	controllers: [RailwayWebhookController],
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		RailwayApiService,
		DeploymentMirrorService,
		RailwayPollCron,
	],
	exports: [RailwayApiService, DeploymentMirrorService],
})
export class RailwayModule {}
