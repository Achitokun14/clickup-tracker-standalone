import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port || '6379', 10),
      password: u.password || undefined,
      username: u.username !== 'default' ? u.username : undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

type JobHandler = (job: Job) => Promise<any>;

/**
 * Thin BullMQ wrapper. Ported from billing-service/src/queue/queue.service.ts —
 * if Redis is unreachable, addJob() degrades to inline execution so the daemon
 * still works (with a loud warning).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QueueService.name);
  private readonly connection = parseRedisUrl(REDIS_URL);
  private queues = new Map<string, Queue>();
  private workers = new Map<string, Worker>();
  private handlers = new Map<string, JobHandler>();
  private degraded = false;

  async onModuleInit(): Promise<void> {
    this.log.log(`queue init (redis ${this.connection.host}:${this.connection.port})`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const [name, worker] of this.workers) {
      try {
        await worker.close();
        this.log.log(`worker ${name} closed`);
      } catch (err) {
        this.log.warn(`worker ${name} close failed: ${(err as Error).message}`);
      }
    }
    for (const [name, queue] of this.queues) {
      try {
        await queue.close();
      } catch (err) {
        this.log.warn(`queue ${name} close failed: ${(err as Error).message}`);
      }
    }
  }

  registerQueue(name: string, handler: JobHandler): void {
    if (this.queues.has(name)) return;
    this.handlers.set(name, handler);

    try {
      const queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);

      const worker = new Worker(
        name,
        async (job) => {
          try {
            return await handler(job);
          } catch (err) {
            this.log.error(`job ${name}:${job.id} failed: ${(err as Error).message}`);
            throw err;
          }
        },
        { connection: this.connection, concurrency: 3 },
      );
      worker.on('completed', (job) => this.log.debug(`job ${name}:${job.id} ok`));
      worker.on('failed', (job, err) => this.log.error(`job ${name}:${job?.id} failed: ${err.message}`));
      this.workers.set(name, worker);
      this.log.log(`queue "${name}" ready`);
    } catch (err) {
      this.degraded = true;
      this.log.warn(`queue "${name}" unavailable; inline mode: ${(err as Error).message}`);
    }
  }

  async addJob(
    queueName: string,
    data: unknown,
    opts?: { delay?: number; attempts?: number; jobId?: string },
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    const handler = this.handlers.get(queueName);

    if (!queue) {
      if (handler) {
        try {
          await handler({ data } as Job);
        } catch (err) {
          this.log.warn(`inline ${queueName} handler failed: ${(err as Error).message}`);
        }
      }
      return;
    }

    try {
      await queue.add(queueName, data, {
        attempts: opts?.attempts ?? 3,
        backoff: { type: 'exponential', delay: 5000 },
        delay: opts?.delay,
        jobId: opts?.jobId,
        removeOnComplete: 1000,
        removeOnFail: 500,
      });
    } catch (err) {
      this.log.warn(`addJob ${queueName} fell through to inline: ${(err as Error).message}`);
      if (handler) {
        try {
          await handler({ data } as Job);
        } catch {
          /* swallow */
        }
      }
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }
}
