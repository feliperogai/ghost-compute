// Self-service credential hygiene: see, mint and revoke your own API tokens.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, isStaff } from '../../auth/plugin.js';
import { generateSecret, hashSecret } from '../../auth/crypto.js';
import { audit } from '../../audit.js';
import { conflict, notFound, unauthorized } from '../../errors.js';
import { uuidParam } from '../schemas.js';

/** Unrevoked, unexpired tokens one account may hold. */
const MAX_ACTIVE_TOKENS = 20;

export const accountRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const me = (req: { principal?: unknown }) => {
      const p = req.principal as { kind: string; userId: string; role: 'admin' | 'operator' | 'viewer' | 'member'; tokenId: string } | undefined;
      if (!p || p.kind !== 'user') throw unauthorized();
      return p;
    };

    app.get('/v1/me', { onRequest: requireUser(ctx, 'member') }, async (req) => {
      const p = me(req);
      const { rows } = await ctx.db.query(`SELECT id, email, role, created_at FROM users WHERE id = $1`, [p.userId]);
      return { id: rows[0].id, email: rows[0].email, role: rows[0].role, createdAt: rows[0].created_at.toISOString() };
    });

    app.get('/v1/me/tokens', { onRequest: requireUser(ctx, 'member') }, async (req) => {
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
        config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
        schema: {
          body: z.object({ name: z.string().trim().min(1).max(100), ttlDays: z.number().int().min(1).max(365).optional() }).strict(),
        },
      },
      async (req, reply) => {
        const p = me(req);
        // Public accounts never get a token longer-lived than the platform allows.
        const max = isStaff(p.role) ? 365 : ctx.config.MEMBER_TOKEN_TTL_DAYS;
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

    app.delete('/v1/me/tokens/:id', { onRequest: requireUser(ctx, 'member'), schema: { params: uuidParam } }, async (req) => {
      const p = me(req);
      const { rows } = await ctx.db.query(
        `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id`,
        [req.params.id, p.userId],
      );
      if (!rows[0]) throw notFound('Token');
      await audit(ctx.db, { actorType: 'user', actorId: p.userId, action: 'token.revoke', targetType: 'api_token', targetId: req.params.id });
      return { id: req.params.id, revoked: true };
    });
  };
