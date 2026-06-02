import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, userId } from '../auth/plugin.js';
import { AppError } from '../errors.js';
import { uuidParam } from '../modules/schemas.js';
import { createUserWithToken } from '../modules/admin/service.js';
import { requirementsSchema, resourcesSchema } from '../jobs/schemas.js';
import { WORKLOAD_TYPES } from '../scheduler/catalog.js';
import { creditAmount } from '../credits/pricing.js';
import { offerInputSchema } from './offer.js';
import { MarketService } from './service.js';

/** Open platform: self-service accounts, provider offers, market listing and quotes. */
export const marketRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new MarketService(ctx);

    // ---- accounts ---------------------------------------------------------------

    app.post(
      '/v1/signup',
      {
        config: { rateLimit: { max: ctx.config.SIGNUP_PER_IP_PER_HOUR, timeWindow: '1 hour' } },
        schema: { body: z.object({ email: z.email().max(254) }).strict() },
      },
      async (req, reply) => {
        if (!ctx.config.OPEN_SIGNUP) throw new AppError(403, 'SIGNUP_CLOSED', 'Self-service sign-up is disabled');
        // Public accounts are always 'member': their own jobs, computers and credits only.
        const res = await createUserWithToken(
          ctx,
          { email: req.body.email.toLowerCase(), role: 'member', tokenName: 'signup' },
          null,
          ctx.config.SIGNUP_CREDITS,
        );
        return reply.status(201).send({ ...res, role: 'member', credits: ctx.config.SIGNUP_CREDITS });
      },
    );

    // ---- providers --------------------------------------------------------------

    app.post(
      '/v1/provider/enrollment-tokens',
      {
        onRequest: requireUser(ctx, 'member'),
        config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
        schema: {
          body: z
            .object({
              ttlSeconds: z.number().int().min(60).max(86_400).default(3600),
              note: z.string().max(200).optional(),
            })
            .strict()
            .default({ ttlSeconds: 3600 }),
        },
      },
      async (req, reply) => reply.status(201).send(await svc.enrollmentToken(userId(req), req.body)),
    );

    app.get('/v1/provider/workers', { onRequest: requireUser(ctx, 'member') }, async (req) => svc.myWorkers(userId(req)));

    app.get(
      '/v1/provider/workers/:id/offer',
      { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } },
      async (req) => svc.getOffer(userId(req), req.params.id),
    );

    app.put(
      '/v1/provider/workers/:id/offer',
      { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam, body: offerInputSchema } },
      async (req) => svc.setOffer(userId(req), req.params.id, req.body),
    );

    // A provider can take a computer off the platform for good (e.g. it was stolen or
    // compromised): its credentials stop working at once and its jobs are re-routed.
    app.post(
      '/v1/provider/workers/:id/revoke',
      {
        onRequest: requireUser(ctx, 'member'),
        schema: { params: uuidParam, body: z.object({ reason: z.string().trim().min(1).max(500) }).strict() },
      },
      async (req) => svc.revoke(userId(req), req.params.id, req.body.reason),
    );

    // ---- customers ----------------------------------------------------------------

    app.get(
      '/v1/market/offers',
      {
        onRequest: requireUser(ctx, 'member'),
        schema: {
          querystring: z.object({
            type: z.string().max(64).optional(),
            gpu: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
            availableNow: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        },
      },
      async (req) => svc.offers(req.query),
    );

    app.get(
      '/v1/market/workers/:id/reputation',
      { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } },
      async (req) => svc.reputation(req.params.id),
    );

    app.post(
      '/v1/market/quote',
      {
        onRequest: requireUser(ctx, 'member'),
        schema: {
          body: z
            .object({
              type: z.enum(WORKLOAD_TYPES.map((t) => t.id) as [string, ...string[]]),
              requirements: requirementsSchema.default({}),
              resources: resourcesSchema.default({ cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 }),
              timeout: z.number().int().min(10).max(604_800).default(ctx.config.JOB_DEFAULT_TIMEOUT_SECONDS),
              priority: z.number().int().min(0).max(100).default(50),
              budget: creditAmount.optional(),
              verification: z.enum(['none', 'replicate']).optional(),
            })
            .strict(),
        },
      },
      async (req) => svc.quote(userId(req), req.body),
    );
  };
