import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CredentialsService } from "../credentials/credentials.service";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { CustomFieldsService } from "../clickup/custom-fields";
import { ViewsService } from "../clickup/views";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { BackupService } from "../backup/backup.service";
import { QueueModule } from "../queue/queue.module";
import { RepairService } from "../repair/repair.service";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { LookupService } from "./lookup.service";
import { AdoptService } from "./adopt.service";
import { OrphanDetectionCron } from "./orphan-detection.cron";
import { GithubIdentityService } from "./github-identity.service";
import { ContributorService } from "../scrum/contributor.service";
import { OwnershipService } from "../scrum/ownership.service";
import { QualityService } from "../scrum/quality.service";

@Module({
	imports: [QueueModule],
	controllers: [ProjectsController],
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		CustomFieldsService,
		ViewsService,
		BackupService,
		ProjectsService,
		RepairService,
		LookupService,
		AdoptService,
		OrphanDetectionCron,
		GithubIdentityService,
		ContributorService,
		OwnershipService,
		QualityService,
	],
	exports: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		CustomFieldsService,
		ViewsService,
		BackupService,
		ProjectsService,
		RepairService,
		LookupService,
		AdoptService,
		GithubIdentityService,
	],
})
export class ProjectsModule {}
