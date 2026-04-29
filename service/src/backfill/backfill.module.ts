import { Module } from "@nestjs/common";
import { ExtractorsModule } from "../extractors/extractors.module";
import { ProjectsModule } from "../projects/projects.module";
import { BackfillController } from "./backfill.controller";
import { BackfillService } from "./backfill.service";

/**
 * Per-repo Space backfill orchestrator. Consumes the planner from Session 3
 * and the extended ClickUpDirectService from Session 2 to build a complete
 * Space tree on demand. Resumable + idempotent via projects.task_index.
 */
@Module({
	imports: [ProjectsModule, ExtractorsModule],
	controllers: [BackfillController],
	providers: [BackfillService],
	exports: [BackfillService],
})
export class BackfillModule {}
