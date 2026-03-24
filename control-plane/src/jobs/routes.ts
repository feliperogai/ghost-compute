import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireWorker, userId, workerId } from '../auth/plugin.js';
import { unauthorized } from '../errors.js';
import { boundedJson, optionalBody, uuidParam } from '../modules/schemas.js';
import { WORKLOAD_TYPES } from '../scheduler/catalog.js';
import { createJobSchema, jobStatusSchema, MAX_CHECKPOINT_BYTES, resultSchema } from './schemas.js';
import { JobService } from './service.js';
import { JobLifecycle } from './lifecycle.js';

/** Owner/operator API. */
export const jobRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new JobService(ctx);

    app.get('/v1/workload-types', { onRequest: requireUser(ctx, 'viewer') }, async () => ({ items: WORKLOAD_TYPES }));

    app.post(
      '/v1/jobs',
      { onRequest: requireUser(ctx, 'operator'), schema: { body: createJobSchema } },
      async (req, reply) => reply.status(201).send(await svc.create(req.body, userId(req))),
    );

    app.get(
      '/v1/jobs',
      {
        onRequest: requireUser(ctx, 'viewer'),
        schema: {
          querystring: z.object({
            status: jobStatusSchema.optional(),
            type: z.string().max(64).optional(),
            owner: z.union([z.literal('me'), z.uuid()]).optional(),
            since: z.iso.datetime({ offset: true }).optional(),
            until: z.iso.datetime({ offset: true }).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            cursor: z.string().max(500).optional(),
          }),
        },
      },
      async (req) => {
        const { owner, ...q } = req.query;
        return svc.list({ ...q, ownerId: owner === 'me' ? userId(req) : owner });
      },
    );

    app.get('/v1/jobs/:id', { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } }, async (req) =>
      svc.get(req.params.id),
    );

    app.get(
      '/v1/jobs/:id/decisions',
      { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } },
      async (req) => svc.decisions(req.params.id),
    );

    app.get(
      '/v1/jobs/:id/events',
      {
        onRequest: requireUser(ctx, 'viewer'),
        schema: {
          params: uuidParam,
          querystring: z.object({
            afterId: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(1000).default(200),
          }),
        },
      },
      async (req) => svc.events(req.params.id, req.query.afterId, req.query.limit),
    );

    app.post(
      '/v1/jobs/:id/cancel',
      {
        onRequest: requireUser(ctx, 'operator'),
        schema: {
          params: uuidParam,
          body: optionalBody(z.object({ reason: z.string().trim().min(1).max(500).default('cancelled by owner') })),
        },
      },
      async (req) => {
        if (req.principal?.kind !== 'user') throw unauthorized();
        return svc.cancel(req.params.id, req.body.reason, { userId: req.principal.userId, role: req.principal.role });
      },
    );
  };

/** Worker API for its assignments. */
export const assignmentRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const lc = new JobLifecycle(ctx);
    app.addHook('onRequest', requireWorker(ctx));

    app.get('/v1/worker/assignments', async (req) => ({ items: await lc.pendingFor(workerId(req)) }));

    app.post('/v1/worker/assignments/:id/accept', { schema: { params: uuidParam } }, async (req) =>
      lc.accept(workerId(req), req.params.id),
    );

    app.post(
      '/v1/worker/assignments/:id/reject',
      { schema: { params: uuidParam, body: z.object({ reason: z.string().trim().min(1).max(500) }) } },
      async (req) => lc.reject(workerId(req), req.params.id, req.body.reason),
    );

    app.post(
      '/v1/worker/assignments/:id/progress',
      {
        schema: {
          params: uuidParam,
          body: z.object({
            progress: z.number().min(0).max(1),
            stage: z.string().trim().min(1).max(100).optional(),
            /** Partial results (resumable workloads); validated against the job's input. */
            checkpoint: boundedJson(MAX_CHECKPOINT_BYTES).optional(),
          }),
        },
      },
      async (req) =>
        lc.progress(workerId(req), req.params.id, req.body.progress, req.body.stage, req.body.checkpoint),
    );

    app.post('/v1/worker/assignments/:id/result', { schema: { params: uuidParam, body: resultSchema } }, async (req) => {
      const b = req.body;
      return b.status === 'completed'
        ? lc.complete(workerId(req), req.params.id, b.output, b.outputSha256)
        : lc.fail(workerId(req), req.params.id, b.error, b.retryable);
    });
  };
