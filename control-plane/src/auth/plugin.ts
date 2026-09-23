import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { hashSecret, hasPrefix, verifyWorkerToken } from './crypto.js';

export type Role = 'admin' | 'operator' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export type Principal =
  | { kind: 'user'; userId: string; role: Role; tokenId: string }
  | { kind: 'worker'; workerId: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export async function resolveUserToken(ctx: AppContext, token: string): Promise<Principal | null> {
  if (!hasPrefix(token, 'user')) return null;
  const { rows } = await ctx.db.query<{ token_id: string; user_id: string; role: Role }>(
    `SELECT t.id AS token_id, u.id AS user_id, u.role
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL`,
    [hashSecret(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // Coarse last-use tracking; not on the critical path.
  ctx.db
    .query(
      `UPDATE api_tokens SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.token_id],
    )
    .catch(() => {});
  return { kind: 'user', userId: row.user_id, role: row.role, tokenId: row.token_id };
}

export async function resolveWorkerToken(ctx: AppContext, token: string): Promise<Principal | null> {
  const claims = verifyWorkerToken(token, ctx.config.WORKER_TOKEN_SECRET);
  if (!claims) return null;
  // Checked on every request so revocation is immediate.
  const { rows } = await ctx.db.query(`SELECT 1 FROM workers WHERE id = $1 AND status = 'active'`, [claims.sub]);
  return rows.length ? { kind: 'worker', workerId: claims.sub } : null;
}

export function requireUser(ctx: AppContext, minRole: Role = 'viewer'): onRequestAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearer(req);
    const p = token ? await resolveUserToken(ctx, token) : null;
    if (!p || p.kind !== 'user') throw unauthorized();
    if (RANK[p.role] < RANK[minRole]) throw forbidden();
    req.principal = p;
    req.log = req.log.child({ userId: p.userId });
  };
}

export function requireWorker(ctx: AppContext): onRequestAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearer(req);
    const p = token ? await resolveWorkerToken(ctx, token) : null;
    if (!p || p.kind !== 'worker') throw unauthorized();
    req.principal = p;
    req.log = req.log.child({ workerId: p.workerId });
  };
}

export function userId(req: FastifyRequest): string {
  if (req.principal?.kind !== 'user') throw unauthorized();
  return req.principal.userId;
}

export function workerId(req: FastifyRequest): string {
  if (req.principal?.kind !== 'worker') throw unauthorized();
  return req.principal.workerId;
}
