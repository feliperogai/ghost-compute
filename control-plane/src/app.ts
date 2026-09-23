import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from './context.js';
import { errorHandler } from './errors.js';
import { adminRoutes } from './modules/admin/routes.js';
import { workerRoutes } from './modules/workers/routes.js';
import { assignmentRoutes, jobRoutes } from './jobs/routes.js';
import { registerWebSocket } from './events/ws.js';
import { inferenceRoutes, workerImageRoutes } from './inference/routes.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
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
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }),
  );
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(rateLimit, { global: false, redis: ctx.redis, nameSpace: 'ghost:rl:' });
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
  registerWebSocket(app, ctx);

  return app;
}
