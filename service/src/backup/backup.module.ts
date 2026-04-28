import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { BackupController } from './backup.controller';

@Module({
  imports: [ProjectsModule], // re-exports BackupService
  controllers: [BackupController],
})
export class BackupModule {}
