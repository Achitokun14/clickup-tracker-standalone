import { Controller, Get, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

@Controller('public')
export class OpenApiController {
  private readonly log = new Logger(OpenApiController.name);
  private cached: string | null = null;

  @Get('openapi.yaml')
  spec(): string {
    if (this.cached) return this.cached;
    try {
      const candidates = [
        join(process.cwd(), 'openapi.yaml'),
        join(__dirname, '..', '..', 'openapi.yaml'),
        join(__dirname, '..', '..', '..', 'openapi.yaml'),
      ];
      for (const p of candidates) {
        try {
          this.cached = readFileSync(p, 'utf8');
          return this.cached;
        } catch {
          /* try next */
        }
      }
    } catch (err) {
      this.log.warn(`openapi.yaml unreadable: ${(err as Error).message}`);
    }
    return '# openapi.yaml not bundled in this build';
  }
}
