import { Module } from "@nestjs/common";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { CredentialsService } from "../credentials/credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { ContributorService } from "./contributor.service";
import { GroomerService } from "./groomer.service";
import { LeadershipService } from "./leadership.service";
import { OwnershipService } from "./ownership.service";
import { QualityService } from "./quality.service";
import { ReportingService } from "./reporting.service";
import { ReviewEventsService } from "./review-events.service";
import { ReviewerSuggesterService } from "./reviewer-suggester";
import { WorkspaceRollupService } from "./workspace-rollup.service";
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
		ReportingService,
		ContributorService,
		ReviewEventsService,
		OwnershipService,
		WorkspaceRollupService,
		ReviewerSuggesterService,
		QualityService,
		ScrumScheduler,
	],
	exports: [
		AuditService,
		LeadershipService,
		SprintPlannerService,
		GroomerService,
		ReportingService,
		ContributorService,
		ReviewEventsService,
		OwnershipService,
		WorkspaceRollupService,
		ReviewerSuggesterService,
		QualityService,
	],
})
export class ScrumModule {}
