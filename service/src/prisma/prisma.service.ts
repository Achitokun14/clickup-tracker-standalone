import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  async onModuleInit() {
    // Lazy connect — Prisma will dial on first query. Failing here would
    // block the whole service from booting, including /health, which makes
    // diagnosis harder when the DB is down. Log instead, succeed module init.
    try {
      await this.$connect();
    } catch (err) {
      this.log.warn(`prisma initial connect failed: ${(err as Error).message}; will retry on demand`);
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
    } catch {
      /* ignore */
    }
  }
}
