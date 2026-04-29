import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health/health.controller";
import { OpenApiController } from "./health/openapi.controller";
import { MetricsController } from "./metrics/metrics.controller";
import { ProjectsModule } from "./projects/projects.module";
import { EventsModule } from "./events/events.module";
import { QueueModule } from "./queue/queue.module";
import { SyncModule } from "./sync/sync.module";
import { BackupModule } from "./backup/backup.module";
import { BackfillModule } from "./backfill/backfill.module";
import { ClickUpWebhooksModule } from "./clickup-webhooks/clickup-webhooks.module";

@Module({
	imports: [
		ScheduleModule.forRoot(),
		QueueModule,
		ProjectsModule,
		EventsModule,
		SyncModule,
		BackupModule,
		BackfillModule,
		ClickUpWebhooksModule,
	],
	controllers: [HealthController, OpenApiController, MetricsController],
	providers: [],
})
export class AppModule {}
