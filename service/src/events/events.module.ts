import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { SyncModule } from '../sync/sync.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { GitHmacGuard } from './git-hmac.guard';

@Module({
  imports: [ProjectsModule, SyncModule], // re-exports PrismaService, CredentialsService, ClickUpDirectService, SyncService
  controllers: [EventsController],
  providers: [EventsService, GitHmacGuard],
  exports: [EventsService],
})
export class EventsModule {}
