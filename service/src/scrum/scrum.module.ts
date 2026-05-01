import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { LeadershipService } from "./leadership.service";
import { ScrumController } from "./scrum.controller";
import { SprintPlannerService } from "./sprint-planner.service";

@Module({
	controllers: [ScrumController],
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		AuditService,
		LeadershipService,
		SprintPlannerService,
	],
	exports: [AuditService, LeadershipService, SprintPlannerService],
})
export class ScrumModule {}
