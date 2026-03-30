import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, userId } from '../auth/plugin.js';
import { unauthorized } from '../errors.js';
import { uuidParam } from '../modules/schemas.js';
import { CreditService, type CreditActor } from './service.js';
import { toMilli } from './pricing.js';

/** Max credits in one grant or withdrawal. */
const MAX_CREDITS = 1_000_000_000;

/** Positive credit amount with at most 3 decimals → millicredits. Rejects 0, negatives, NaN, 1e-4. */
const creditAmount = z
  .number()
  .positive()
  .max(MAX_CREDITS)
  .transform((v, ctx) => {
    const m = toMilli(v);
    if (m === null || m <= 0) {
      ctx.addIssue({ code: 'custom', message: `amount must be a positive number of credits with at most 3 decimals` });
      return z.NEVER;
    }
    return m;
  });

const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey: 8–128 of [A-Za-z0-9._:-]');

const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().min(1).optional(),
});

function actor(req: FastifyRequest): CreditActor {
  if (req.principal?.kind !== 'user') throw unauthorized();
  return { userId: req.principal.userId, role: req.principal.role };
}

/** Internal virtual credits: read models for everyone, grants for admins. */
export const creditRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new CreditService(ctx);

    app.get('/v1/credits/wallet', { onRequest: requireUser(ctx, 'viewer') }, async (req) => svc.userWallet(userId(req)));

    app.get(
      '/v1/credits/transactions',
      {
        onRequest: requireUser(ctx, 'viewer'),
        schema: {
          querystring: page.extend({ kind: z.enum(['grant', 'earning', 'hold', 'settlement', 'withdrawal']).optional() }),
        },
      },
      async (req) =>
        svc.userTransactions(userId(req), { limit: req.query.limit, beforeSeq: req.query.cursor, kind: req.query.kind }),
    );

    app.get(
      '/v1/credits/earnings',
      { onRequest: requireUser(ctx, 'viewer'), schema: { querystring: page.extend({ workerId: z.uuid().optional() }) } },
      async (req) =>
        svc.earnings(actor(req), { workerId: req.query.workerId, limit: req.query.limit, beforeSeq: req.query.cursor }),
    );

    app.get('/v1/credits/spending', { onRequest: requireUser(ctx, 'viewer'), schema: { querystring: page } }, async (req) =>
      svc.spending(userId(req), { limit: req.query.limit, beforeSeq: req.query.cursor }),
    );

    app.get(
      '/v1/credits/workers/:id/wallet',
      { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } },
      async (req) => svc.workerWallet(actor(req), req.params.id),
    );

    app.get(
      '/v1/credits/workers/:id/transactions',
      { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam, querystring: page } },
      async (req) => svc.workerTransactions(actor(req), req.params.id, { limit: req.query.limit, beforeSeq: req.query.cursor }),
    );

    app.post(
      '/v1/credits/workers/:id/withdraw',
      {
        onRequest: requireUser(ctx, 'operator'),
        schema: { params: uuidParam, body: z.object({ amount: creditAmount, idempotencyKey }).strict() },
      },
      async (req, reply) => {
        const r = await svc.withdraw(actor(req), req.params.id, req.body);
        return reply.status(r.replayed ? 200 : 201).send(r);
      },
    );

    // ---- admin ---------------------------------------------------------------------

    app.post(
      '/v1/credits/grants',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: {
          body: z
            .object({ userId: z.uuid(), amount: creditAmount, reason: z.string().trim().min(1).max(500), idempotencyKey })
            .strict(),
        },
      },
      async (req, reply) => {
        const r = await svc.grant(actor(req), req.body);
        return reply.status(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get('/v1/credits/summary', { onRequest: requireUser(ctx, 'admin') }, async () => svc.summary());

    app.get(
      '/v1/credits/ledger',
      {
        onRequest: requireUser(ctx, 'admin'),
        schema: {
          querystring: z.object({
            after: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(500).default(100),
            jobId: z.uuid().optional(),
            kind: z.enum(['grant', 'earning', 'hold', 'settlement', 'withdrawal']).optional(),
          }),
        },
      },
      async (req) => svc.ledger({ afterSeq: req.query.after, limit: req.query.limit, jobId: req.query.jobId, kind: req.query.kind }),
    );

    app.get('/v1/credits/ledger/verify', { onRequest: requireUser(ctx, 'admin') }, async () => svc.verify());
  };
