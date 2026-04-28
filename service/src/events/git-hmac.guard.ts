import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const TIMESTAMP_DRIFT_SECS = 5 * 60;

/**
 * HMAC verification for `/public/git-events` and `/public/prompt-events`.
 *
 * Headers expected on incoming POST:
 *   X-CUP-Project-ID: <uuid>
 *   X-CUP-Timestamp:  <unix seconds>
 *   X-CUP-Signature:  sha256=<hex hmac of the raw body using the project's hook_secret>
 *   X-CUP-Idempotency-Key: <opaque>
 *
 * The raw body bytes (preserved by the json content-type parser in main.ts)
 * are what the HMAC is computed over — never the JSON-stringified parsed
 * representation, since whitespace differences would invalidate the sig.
 */
@Injectable()
export class GitHmacGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const headers = req.headers || {};
    const projectId = headers['x-cup-project-id'];
    const ts = parseInt(headers['x-cup-timestamp'] || '0', 10);
    const sig = headers['x-cup-signature'] || '';
    const rawBody: Buffer | undefined = req.rawBody;

    if (!projectId) throw new UnauthorizedException({ code: 'MISSING_PROJECT_ID' });
    if (!ts) throw new UnauthorizedException({ code: 'MISSING_TIMESTAMP' });
    if (!sig) throw new UnauthorizedException({ code: 'MISSING_SIGNATURE' });
    if (!rawBody) throw new UnauthorizedException({ code: 'MISSING_RAW_BODY' });

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > TIMESTAMP_DRIFT_SECS) {
      throw new UnauthorizedException({ code: 'STALE_TIMESTAMP', drift_seconds: now - ts });
    }

    // Look up the secret. Single-row query, indexed.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ hook_secret: string; organisation_id: string; status: string }>
    >(
      `SELECT hook_secret, organisation_id, status
       FROM clickup_tracker.projects
       WHERE id = $1::uuid
       LIMIT 1`,
      projectId,
    );
    if (rows.length === 0) {
      throw new UnauthorizedException({ code: 'UNKNOWN_PROJECT' });
    }
    const project = rows[0];
    if (project.status === 'removed') {
      throw new UnauthorizedException({ code: 'PROJECT_REMOVED' });
    }

    const expected = 'sha256=' + createHmac('sha256', project.hook_secret).update(rawBody).digest('hex');
    const provided = String(sig);

    // timingSafeEqual requires equal-length buffers. Bail early on mismatch.
    if (provided.length !== expected.length) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE' });
    }
    const ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE' });
    }

    // Stash on req for the controller / service to use without re-querying.
    req.cupProject = { id: projectId, organisation_id: project.organisation_id };
    return true;
  }
}
