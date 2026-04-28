import { Controller, Get, Header, Req, UnauthorizedException } from '@nestjs/common';
import * as promClient from 'prom-client';
import { register } from './registry';

/**
 * Prometheus scrape endpoint. Public route (bypasses InternalAuthGuard).
 * If METRICS_AUTH_TOKEN is set, requires Bearer auth; otherwise open.
 */
@Controller('public/metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', promClient.register.contentType)
  async metrics(@Req() req: any): Promise<string> {
    const required = process.env.METRICS_AUTH_TOKEN;
    if (required) {
      const header: string = req?.headers?.authorization || req?.raw?.headers?.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (token !== required) {
        throw new UnauthorizedException('metrics endpoint requires a bearer token');
      }
    }
    return register.metrics();
  }
}
