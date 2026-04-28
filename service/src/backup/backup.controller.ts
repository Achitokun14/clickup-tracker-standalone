import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BackupService, RestoreMode } from './backup.service';

interface RestoreBody {
  backupId?: string;
  mode?: RestoreMode;
  confirm?: boolean;
}

@Controller('projects/:id')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Post('backup')
  async create(@Param('id') projectId: string) {
    const record = await this.backups.take(projectId, 'manual');
    return { ok: true, backup: record };
  }

  @Get('backups')
  async list(@Param('id') projectId: string) {
    const records = await this.backups.list(projectId);
    return { ok: true, backups: records };
  }

  @Post('restore')
  async restore(@Param('id') projectId: string, @Body() body: RestoreBody) {
    if (!body.backupId) {
      throw new BadRequestException('backupId is required');
    }
    const mode = (body.mode ?? 'additive') as RestoreMode;
    if (mode === 'replace' && !body.confirm) {
      throw new BadRequestException('replace mode is destructive — pass { "confirm": true } to proceed');
    }
    const result = await this.backups.restore(projectId, body.backupId, mode);
    return { ok: true, ...result };
  }
}
