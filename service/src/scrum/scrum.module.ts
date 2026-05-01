import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { GroomerService } from "./groomer.service";
import { LeadershipService } from "./leadership.service";
import { ScrumController } from "./scrum.controller";
import { ScrumScheduler } from "./scrum.scheduler";
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
		GroomerService,
		ScrumScheduler,
	],
	exports: [
		AuditService,
		LeadershipService,
		SprintPlannerService,
		GroomerService,
	],
})
export class ScrumModule {}
