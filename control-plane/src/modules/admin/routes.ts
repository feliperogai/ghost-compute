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
            role: z.enum(['admin', 'operator', 'viewer', 'member']),
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

    // Security review, newest first: e.g. action=verification.contradicted lists computers a
    // trusted computer caught returning a different answer.
    app.get(
      '/v1/admin/audit',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: {
          querystring: z.object({
            action: z.string().min(1).max(100).optional(),
            targetId: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
        },
      },
      async (req) => {
        const q = req.query;
        const { rows } = await ctx.db.query(
          `SELECT id, ts, actor_type, actor_id, action, target_type, target_id, details FROM audit_log
            WHERE ($1::text IS NULL OR action = $1) AND ($2::uuid IS NULL OR target_id = $2)
            ORDER BY id DESC LIMIT $3`,
          [q.action ?? null, q.targetId ?? null, q.limit],
        );
        return {
          items: rows.map((r) => ({
            id: Number(r.id),
            at: r.ts.toISOString(),
            actor: { type: r.actor_type, id: r.actor_id },
            action: r.action,
            target: r.target_type ? { type: r.target_type, id: r.target_id } : null,
            details: r.details,
          })),
        };
      },
    );
  };
