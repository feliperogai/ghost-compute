import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from './context.js';
import { errorHandler } from './errors.js';
import { adminRoutes } from './modules/admin/routes.js';
import { workerRoutes } from './modules/workers/routes.js';
import { assignmentRoutes, jobRoutes } from './jobs/routes.js';
import { registerWebSocket } from './events/ws.js';
import { inferenceRoutes, workerImageRoutes } from './inference/routes.js';
import { calibrationWorkerRoutes, performanceRoutes } from './performance/routes.js';
import { HttpMetrics } from './observability/http-metrics.js';
import { dashboardRoutes, serveDashboard } from './observability/routes.js';
import { creditRoutes } from './credits/routes.js';
import { marketRoutes } from './market/routes.js';
import { accountRoutes } from './modules/account/routes.js';

/** Rate-limit bucket: the credential when there is one (not the raw token), else the IP. */
export function rateLimitKey(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (typeof h === 'string' && /^bearer\s+\S+$/i.test(h)) return `t:${createHash('sha256').update(h.split(/\s+/)[1]!).digest('hex').slice(0, 32)}`;
  return `ip:${req.ip}`;
}

function securityHeaders(url: string, reply: FastifyReply, tls: boolean) {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cross-origin-resource-policy', 'same-origin');
  if (!url.startsWith('/dashboard')) {
    // API responses are data, never pages: no framing, no caching of account data.
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
  }
  if (tls) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-ghost-otp"]',
          '*.token',
          '*.workerSecret',
          '*.secret',
          '*.enrollmentToken',
        ],
        censor: '[REDACTED]',
      },
      base: { service: 'ghost-control-plane' },
    },
    bodyLimit: ctx.config.MAX_BODY_BYTES,
    // A caller-supplied request id is kept only if it is short and plain (it ends up in logs).
    requestIdHeader: false,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(h) ? h : randomUUID();
    },
    trustProxy:
      typeof ctx.config.TRUST_PROXY === 'number'
        ? ((hops: number) => (_addr: string, i: number) => i < hops)(ctx.config.TRUST_PROXY)
        : ctx.config.TRUST_PROXY,
    // Slow clients (slowloris) cannot hold sockets forever.
    requestTimeout: ctx.config.REQUEST_TIMEOUT_MS,
    connectionTimeout: ctx.config.REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  new HttpMetrics(ctx.db).register(app);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    securityHeaders(req.url, reply, ctx.config.REQUIRE_TLS);
  });
  if (ctx.config.REQUIRE_TLS)
    app.addHook('onRequest', async (req, reply) => {
      if (req.protocol !== 'https' && req.url !== '/healthz' && req.url !== '/readyz')
        return reply.status(403).send({ error: { code: 'TLS_REQUIRED', message: 'Use HTTPS', requestId: req.id } });
    });

  // Every route is rate limited per credential (token hash) or, without one, per client IP.
  // Routes with their own, stricter limit (credentials, sign-up) override it.
  await app.register(rateLimit, {
    global: true,
    max: ctx.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: ctx.redis,
    nameSpace: 'ghost:rl:',
    keyGenerator: rateLimitKey,
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });
  // Unknown routes count too (scanners and floods of random URLs).
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }),
  );
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      await ctx.redis.ping();
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  await app.register(adminRoutes(ctx));
  await app.register(workerRoutes(ctx));
  await app.register(jobRoutes(ctx));
  await app.register(assignmentRoutes(ctx));
  await app.register(inferenceRoutes(ctx));
  await app.register(workerImageRoutes(ctx));
  await app.register(calibrationWorkerRoutes(ctx));
  await app.register(performanceRoutes(ctx));
  await app.register(dashboardRoutes(ctx));
  await app.register(creditRoutes(ctx));
  await app.register(marketRoutes(ctx));
  await app.register(accountRoutes(ctx));
  await serveDashboard(app);
  registerWebSocket(app, ctx);

  return app;
}
