import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, userId } from '../../auth/plugin.js';
import { createEnrollmentToken, createUserWithToken } from './service.js';

export const adminRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/v1/admin/users',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: {
          body: z.object({
            email: z.email().max(254),
            role: z.enum(['admin', 'operator', 'viewer']),
            tokenName: z.string().min(1).max(100).default('default'),
          }),
        },
      },
      async (req, reply) => {
        const res = await createUserWithToken(ctx, req.body, userId(req));
        return reply.status(201).send(res);
      },
    );

    app.post(
      '/v1/admin/enrollment-tokens',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: {
          body: z.object({
            ttlSeconds: z.number().int().min(60).max(7 * 86_400).default(3600),
            note: z.string().max(200).optional(),
          }),
        },
      },
      async (req, reply) => reply.status(201).send(await createEnrollmentToken(ctx, req.body, userId(req))),
    );
  };
