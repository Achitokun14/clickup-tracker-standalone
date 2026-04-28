import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { ClickUpDirectService } from '../clickup/clickup-direct.service';
import { BackupService } from '../backup/backup.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [PrismaService, CredentialsService, ClickUpDirectService, BackupService, ProjectsService],
  exports: [PrismaService, CredentialsService, ClickUpDirectService, BackupService, ProjectsService],
})
export class ProjectsModule {}
