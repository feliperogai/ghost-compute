import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireWorker, workerId } from '../auth/plugin.js';
import { unauthorized } from '../errors.js';
import { optionalBody, uuidParam } from '../modules/schemas.js';
import { DatasetService, type Actor } from './datasets.js';
import { InferenceService } from './groups.js';
import { createDatasetSchema, createInferenceSchema, MAX_IMAGE_BYTES } from './schemas.js';

function actor(req: FastifyRequest): Actor {
  if (req.principal?.kind !== 'user') throw unauthorized();
  return { userId: req.principal.userId, role: req.principal.role };
}

/** Owner API: datasets and inference runs. */
export const inferenceRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const datasets = new DatasetService(ctx);
    const runs = new InferenceService(ctx);

    // Raw image uploads. Anything else (multipart, JSON, octet-stream) is refused by content type.
    app.addContentTypeParser(['image/png', 'image/jpeg'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    app.post(
      '/v1/datasets',
      { onRequest: requireUser(ctx, 'member'), schema: { body: createDatasetSchema } },
      async (req, reply) => reply.status(201).send(await datasets.create(req.body.name, actor(req))),
    );

    app.get('/v1/datasets', { onRequest: requireUser(ctx, 'member') }, async (req) => datasets.list(actor(req).userId));

    app.get('/v1/datasets/:id', { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } }, async (req) =>
      datasets.get(req.params.id, actor(req)),
    );

    app.post(
      '/v1/datasets/:id/images',
      {
        onRequest: requireUser(ctx, 'member'),
        bodyLimit: MAX_IMAGE_BYTES,
        schema: {
          params: uuidParam,
          querystring: z.object({ name: z.string().trim().min(1).max(255).optional() }),
        },
      },
      async (req, reply) => {
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const img = await datasets.addImage(req.params.id, actor(req), type, body, req.query.name ?? null);
        return reply.status(201).send(img);
      },
    );

    app.post(
      '/v1/datasets/:id/seal',
      { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } },
      async (req) => datasets.seal(req.params.id, actor(req)),
    );

    app.post(
      '/v1/inference',
      { onRequest: requireUser(ctx, 'member'), schema: { body: createInferenceSchema } },
      async (req, reply) => reply.status(201).send(await runs.create(req.body, actor(req))),
    );

    app.get('/v1/inference', { onRequest: requireUser(ctx, 'member') }, async (req) => runs.list(actor(req).userId));

    app.get('/v1/inference/:id', { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } }, async (req) =>
      runs.get(req.params.id, actor(req)),
    );

    app.get(
      '/v1/inference/:id/result',
      { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } },
      async (req) => runs.result(req.params.id, actor(req)),
    );

    app.post(
      '/v1/inference/:id/cancel',
      {
        onRequest: requireUser(ctx, 'member'),
        schema: {
          params: uuidParam,
          body: optionalBody(z.object({ reason: z.string().trim().min(1).max(500).default('cancelled by owner') })),
        },
      },
      async (req) => runs.cancel(req.params.id, actor(req), req.body.reason),
    );
  };

/** Worker API: image bytes for its running image-inference assignment. */
export const workerImageRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const runs = new InferenceService(ctx);
    app.addHook('onRequest', requireWorker(ctx));
    app.get(
      '/v1/worker/assignments/:id/images/:index',
      { schema: { params: z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(2 ** 31 - 1) }) } },
      async (req, reply) => {
        const img = await runs.imageForAssignment(workerId(req), req.params.id, req.params.index);
        return reply
          .header('content-type', 'application/octet-stream')
          .header('x-content-sha256', img.sha256)
          .header('cache-control', 'no-store')
          .send(img.data);
      },
    );
  };
