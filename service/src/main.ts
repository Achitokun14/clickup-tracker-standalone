import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  ValidationPipe,
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  LoggerService,
} from "@nestjs/common";
import { AppModule } from "./app.module";

const pino = require("pino");

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "clickup-tracker" },
});

class PinoLoggerService implements LoggerService {
  log(message: string, context?: string) {
    pinoLogger.info({ context }, message);
  }
  error(message: string, trace?: string, context?: string) {
    pinoLogger.error({ context, trace }, message);
  }
  warn(message: string, context?: string) {
    pinoLogger.warn({ context }, message);
  }
  debug(message: string, context?: string) {
    pinoLogger.debug({ context }, message);
  }
  verbose(message: string, context?: string) {
    pinoLogger.trace({ context }, message);
  }
}

/**
 * Standalone build: no API gateway in front. Internal routes are
 * protected by a static bearer token (STANDALONE_API_TOKEN). If unset,
 * internal routes are wide open — fine for localhost-only dev, NOT for
 * a public-internet container. Public webhook routes (/public/*) and
 * /health remain HMAC-protected (or open) per the controller layer.
 */
@Injectable()
class StandaloneAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const url: string = req.url || req.raw?.url || "";
    if (url.includes("/public/") || url === "/health") return true;

    const required = process.env.STANDALONE_API_TOKEN;
    if (!required) {
      // Open mode — synthesize a default identity and let the request through.
      req.user = {
        id: "standalone",
        email: "",
        role: "OWNER",
        orgId:
          req.headers?.["x-organisation-id"] ||
          "00000000-0000-0000-0000-000000000000",
      };
      return true;
    }

    const auth: string = req.headers?.["authorization"] || "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (presented !== required) {
      throw new UnauthorizedException("invalid or missing bearer token");
    }
    req.user = {
      id: "standalone",
      email: "",
      role: "OWNER",
      orgId:
        req.headers?.["x-organisation-id"] ||
        "00000000-0000-0000-0000-000000000000",
    };
    return true;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 10 * 1024 * 1024 }),
    {
      logger: new PinoLoggerService(),
      bodyParser: false,
    },
  );

  const fastify: any = app.getHttpAdapter().getInstance();
  try {
    fastify.removeContentTypeParser("application/json");
  } catch {
    // never registered — ignore
  }
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req: any, body: Buffer, done: any) => {
      const url = req.raw?.url || "";
      if (
        url.startsWith("/public/git-events") ||
        url.startsWith("/public/prompt-events")
      ) {
        req.rawBody = body;
      }
      try {
        const parsed = body.length ? JSON.parse(body.toString()) : {};
        done(null, parsed);
      } catch (err) {
        done(err, undefined);
      }
    },
  );

  app.enableShutdownHooks();
  app.useGlobalGuards(new StandaloneAuthGuard());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();

  const port = process.env.PORT || 4020;
  await app.listen(port, "0.0.0.0");
  pinoLogger.info(`clickup-tracker (standalone) running on port ${port}`);
}

bootstrap();
