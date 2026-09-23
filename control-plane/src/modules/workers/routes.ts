import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, requireWorker, userId, workerId } from '../../auth/plugin.js';
import { hardwareSchema, uuidParam } from '../schemas.js';
import { WorkerService } from './service.js';

const credentialRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export const workerRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new WorkerService(ctx);

    // ---- worker-facing -------------------------------------------------------

    app.post(
      '/v1/workers/register',
      {
        config: credentialRateLimit,
        schema: {
          body: z.object({
            enrollmentToken: z.string().min(10).max(200),
            name: z.string().trim().min(1).max(100),
            hardware: hardwareSchema,
            maxConcurrentTasks: z.number().int().min(1).max(256).default(1),
            agentVersion: z.string().max(50).optional(),
            deviceId: z.uuid().optional(),
          }),
        },
      },
      async (req, reply) => reply.status(201).send(await svc.register(req.body)),
    );

    app.post(
      '/v1/workers/auth',
      {
        config: credentialRateLimit,
        schema: { body: z.object({ workerId: z.uuid(), workerSecret: z.string().min(10).max(200) }) },
      },
      async (req) => svc.authenticate(req.body.workerId, req.body.workerSecret),
    );

    app.post(
      '/v1/worker/heartbeat',
      {
        onRequest: requireWorker(ctx),
        schema: {
          body: z.object({
            state: z.enum(['waiting', 'available', 'running', 'paused', 'stopped']),
            usage: z
              .object({
                cpuPercent: z.number().min(0).max(100),
                cpuGhostPercent: z.number().min(0).max(100).optional(),
                ramUsedMb: z.number().int().min(0),
                ramGhostMb: z.number().int().min(0).optional(),
                gpuPercent: z.number().min(0).max(100).optional(),
                temperatureC: z.number().min(-50).max(150).optional(),
                userIdleSeconds: z.number().int().min(0).optional(),
                onBattery: z.boolean().optional(),
              })
              .strict(),
            activeLeaseIds: z.array(z.uuid()).max(256).default([]),
            agentVersion: z.string().max(50).optional(),
          }),
        },
      },
      async (req) => svc.heartbeat(workerId(req), req.body),
    );

    app.get('/v1/worker/me', { onRequest: requireWorker(ctx) }, async (req) => svc.get(workerId(req)));

    // ---- user-facing ---------------------------------------------------------

    app.get(
      '/v1/workers',
      {
        onRequest: requireUser(ctx, 'viewer'),
        schema: {
          querystring: z.object({
            status: z.enum(['active', 'revoked']).optional(),
            state: z.enum(['offline', 'waiting', 'available', 'running', 'paused', 'stopped']).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            offset: z.coerce.number().int().min(0).default(0),
          }),
        },
      },
      async (req) => svc.list(req.query),
    );

    app.get(
      '/v1/workers/:id',
      { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } },
      async (req) => svc.get(req.params.id),
    );

    app.post(
      '/v1/workers/:id/revoke',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: { params: uuidParam, body: z.object({ reason: z.string().trim().min(1).max(500) }) },
      },
      async (req) => svc.revoke(req.params.id, req.body.reason, userId(req)),
    );
  };
