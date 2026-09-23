import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, userId } from '../../auth/plugin.js';
import { boundedJson, optionalBody, requirementsSchema, uuidParam } from '../schemas.js';
import { JobService } from './service.js';

const JOB_STATUS = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
const TASK_STATUS = z.enum(['pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled']);

export const createJobSchema = z.object({
  name: z.string().trim().min(1).max(200),
  module: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'lowercase letters, digits, . _ -'),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'semver'),
  }),
  params: boundedJson(64 * 1024).default({}),
  requirements: requirementsSchema.default({}),
  priority: z.number().int().min(0).max(100).default(50),
  maxRetries: z.number().int().min(0).max(20).default(3),
  inputs: z.array(boundedJson(64 * 1024)).min(1),
});

export const jobRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new JobService(ctx);

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
            status: JOB_STATUS.optional(),
            createdBy: z.uuid().optional(),
            module: z.string().max(100).optional(),
            since: z.iso.datetime({ offset: true }).optional(),
            until: z.iso.datetime({ offset: true }).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            cursor: z.string().max(500).optional(),
          }),
        },
      },
      async (req) => svc.list({ ...req.query, moduleName: req.query.module }),
    );

    app.get(
      '/v1/jobs/:id',
      { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } },
      async (req) => svc.get(req.params.id),
    );

    app.get(
      '/v1/jobs/:id/tasks',
      {
        onRequest: requireUser(ctx, 'viewer'),
        schema: {
          params: uuidParam,
          querystring: z.object({
            status: TASK_STATUS.optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
            offset: z.coerce.number().int().min(0).default(0),
          }),
        },
      },
      async (req) => svc.tasks(req.params.id, req.query),
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
      async (req) => svc.events(req.params.id, req.query),
    );

    app.post(
      '/v1/jobs/:id/cancel',
      {
        onRequest: requireUser(ctx, 'operator'),
        schema: {
          params: uuidParam,
          body: optionalBody(z.object({ reason: z.string().trim().min(1).max(500).default('cancelled by user') })),
        },
      },
      async (req) => svc.cancel(req.params.id, req.body.reason, userId(req)),
    );
  };
