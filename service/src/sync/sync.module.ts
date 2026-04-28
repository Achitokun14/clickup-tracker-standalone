import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DriftCron } from './drift.cron';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [ProjectsModule],
  controllers: [SyncController],
  providers: [SyncService, DriftCron],
  exports: [SyncService],
})
export class SyncModule {}
