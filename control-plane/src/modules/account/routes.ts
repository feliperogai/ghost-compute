// Self-service credential hygiene: see, mint and revoke your own API tokens; turn
// two-step verification (TOTP) on and off.
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, isStaff, mustEnroll } from '../../auth/plugin.js';
import { generateSecret, hashSecret } from '../../auth/crypto.js';
import { audit } from '../../audit.js';
import { conflict, notFound, unauthorized } from '../../errors.js';
import { uuidParam } from '../schemas.js';
import { MfaService, OTP_HEADER, requireSecondFactor } from './mfa.js';

/** Unrevoked, unexpired tokens one account may hold. */
const MAX_ACTIVE_TOKENS = 20;

export const accountRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const me = (req: FastifyRequest) => {
      const p = req.principal;
      if (!p || p.kind !== 'user') throw unauthorized();
      return p;
    };
    const mfa = new MfaService(ctx);
    // Open to staff who still have to turn on two-step verification (REQUIRE_STAFF_MFA).
    const enrolling = requireUser(ctx, 'member', { enrolling: true });

    app.get('/v1/me', { onRequest: enrolling }, async (req) => {
      const p = me(req);
      const { rows } = await ctx.db.query(`SELECT id, email, role, created_at FROM users WHERE id = $1`, [p.userId]);
      return {
        id: rows[0].id,
        email: rows[0].email,
        role: rows[0].role,
        createdAt: rows[0].created_at.toISOString(),
        mfa: { enabled: p.mfa, mustEnroll: mustEnroll(ctx.config, p) },
      };
    });

    app.get('/v1/me/tokens', { onRequest: enrolling }, async (req) => {
      const p = me(req);
      const { rows } = await ctx.db.query(
        `SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at`,
        [p.userId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          current: r.id === p.tokenId,
          createdAt: r.created_at.toISOString(),
          expiresAt: r.expires_at?.toISOString() ?? null,
          lastUsedAt: r.last_used_at?.toISOString() ?? null,
          revokedAt: r.revoked_at?.toISOString() ?? null,
        })),
      };
    });

    app.post(
      '/v1/me/tokens',
      {
        onRequest: requireUser(ctx, 'member'),
        // A stolen token cannot mint its own replacement without the second factor.
        preHandler: requireSecondFactor(ctx),
        config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
        schema: {
          body: z.object({ name: z.string().trim().min(1).max(100), ttlDays: z.number().int().min(1).max(365).optional() }).strict(),
        },
      },
      async (req, reply) => {
        const p = me(req);
        // Nobody gets a token longer-lived than the platform allows for their role.
        const max = isStaff(p.role) ? ctx.config.STAFF_TOKEN_TTL_DAYS : ctx.config.MEMBER_TOKEN_TTL_DAYS;
        const ttl = Math.min(req.body.ttlDays ?? max, max);
        const active = await ctx.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
          [p.userId],
        );
        if (active.rows[0]!.n >= MAX_ACTIVE_TOKENS) throw conflict(`At most ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`);
        const token = generateSecret('user');
        const { rows } = await ctx.db.query(
          `INSERT INTO api_tokens (user_id, name, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
           RETURNING id, expires_at`,
          [p.userId, req.body.name, hashSecret(token), ttl],
        );
        await audit(ctx.db, { actorType: 'user', actorId: p.userId, action: 'token.create', targetType: 'api_token', targetId: rows[0].id });
        return reply.status(201).send({ id: rows[0].id, token, expiresAt: rows[0].expires_at.toISOString() });
      },
    );

    app.delete('/v1/me/tokens/:id', { onRequest: enrolling, schema: { params: uuidParam } }, async (req) => {
      const p = me(req);
      const { rows } = await ctx.db.query(
        `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id`,
        [req.params.id, p.userId],
      );
      if (!rows[0]) throw notFound('Token');
      await audit(ctx.db, { actorType: 'user', actorId: p.userId, action: 'token.revoke', targetType: 'api_token', targetId: req.params.id });
      return { id: req.params.id, revoked: true };
    });

    // ---- two-step verification (TOTP) --------------------------------------------

    app.get('/v1/me/mfa', { onRequest: enrolling }, async (req) => mfa.status(me(req).userId));

    // 1. A new secret for the authenticator app (QR code from `otpauthUrl`)…
    app.post(
      '/v1/me/mfa/totp',
      { onRequest: enrolling, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
      async (req, reply) => reply.status(201).send(await mfa.begin(me(req).userId)),
    );

    // 2. …on once a code from the app proves it was saved.
    app.post(
      '/v1/me/mfa/totp/confirm',
      {
        onRequest: enrolling,
        config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
        schema: { body: z.object({ code: z.string().trim().regex(/^\d{6}$/, '6 digits') }).strict() },
      },
      async (req) => mfa.confirm(me(req).userId, req.body.code),
    );

    // Off (e.g. to move to a new phone): needs a current code.
    app.delete('/v1/me/mfa/totp', { onRequest: enrolling, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
      const h = req.headers[OTP_HEADER];
      return mfa.disable(me(req).userId, typeof h === 'string' ? h : undefined);
    });
  };
