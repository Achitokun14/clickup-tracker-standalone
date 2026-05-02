import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { DigestService } from "./digest.service";
import { SlackService } from "./slack.service";

@Module({
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		DigestService,
		SlackService,
	],
	exports: [DigestService, SlackService],
})
export class NotifyModule {}
