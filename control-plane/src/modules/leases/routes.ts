import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireWorker, workerId } from '../../auth/plugin.js';
import { boundedJson, optionalBody, uuidParam } from '../schemas.js';
import { LeaseService } from './service.js';

const MAX_OUTPUT_BYTES = 256 * 1024;

export const leaseRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new LeaseService(ctx);
    app.addHook('onRequest', requireWorker(ctx));

    app.post(
      '/v1/worker/leases/claim',
      { schema: { body: optionalBody(z.object({ max: z.number().int().min(1).max(64).default(1) })) } },
      async (req) => ({ offers: await svc.offerNext(workerId(req), req.body.max) }),
    );

    app.post('/v1/worker/leases/:id/accept', { schema: { params: uuidParam } }, async (req) =>
      svc.accept(workerId(req), req.params.id),
    );

    app.post(
      '/v1/worker/leases/:id/reject',
      { schema: { params: uuidParam, body: z.object({ reason: z.string().trim().min(1).max(500) }) } },
      async (req) => svc.reject(workerId(req), req.params.id, req.body.reason),
    );

    app.post(
      '/v1/worker/leases/:id/progress',
      {
        schema: {
          params: uuidParam,
          body: z.object({ progress: z.number().min(0).max(1), stage: z.string().trim().min(1).max(100).optional() }),
        },
      },
      async (req) => svc.progress(workerId(req), req.params.id, req.body),
    );

    app.post(
      '/v1/worker/leases/:id/result',
      {
        schema: {
          params: uuidParam,
          body: z.discriminatedUnion('status', [
            z.object({
              status: z.literal('succeeded'),
              output: boundedJson(MAX_OUTPUT_BYTES),
              outputSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
            }),
            z.object({ status: z.literal('failed'), error: z.string().trim().min(1).max(2000) }),
            z.object({ status: z.literal('preempted'), reason: z.string().trim().min(1).max(500) }),
          ]),
        },
      },
      async (req) => svc.complete(workerId(req), req.params.id, req.body),
    );
  };
