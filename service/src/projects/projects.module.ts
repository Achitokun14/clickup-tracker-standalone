import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CredentialsService } from "../credentials/credentials.service";
import { ClickUpDirectService } from "../clickup/clickup-direct.service";
import { ClickUpRateLimiter } from "../clickup/rate-limiter";
import { BackupService } from "../backup/backup.service";
import { QueueModule } from "../queue/queue.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({
	imports: [QueueModule],
	controllers: [ProjectsController],
	providers: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		BackupService,
		ProjectsService,
	],
	exports: [
		PrismaService,
		CredentialsService,
		ClickUpRateLimiter,
		ClickUpDirectService,
		BackupService,
		ProjectsService,
	],
})
export class ProjectsModule {}
