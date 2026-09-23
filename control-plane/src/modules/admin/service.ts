import type { AppContext } from '../../context.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../audit.js';
import { generateSecret, hashSecret } from '../../auth/crypto.js';
import { conflict } from '../../errors.js';
import type { Role } from '../../auth/plugin.js';

export async function createUserWithToken(
  ctx: AppContext,
  input: { email: string; role: Role; tokenName: string },
  actorId: string | null,
) {
  const token = generateSecret('user');
  return withTx(ctx.db, async (c) => {
    const existing = await c.query(`SELECT 1 FROM users WHERE email = $1`, [input.email]);
    if (existing.rows.length) throw conflict('User already exists');
    const u = await c.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id`, [
      input.email,
      input.role,
    ]);
    const userId = u.rows[0]!.id;
    await c.query(`INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, $2, $3)`, [
      userId,
      input.tokenName,
      hashSecret(token),
    ]);
    await audit(c, {
      actorType: actorId ? 'user' : 'system',
      actorId,
      action: 'user.create',
      targetType: 'user',
      targetId: userId,
      details: { email: input.email, role: input.role },
    });
    return { userId, token };
  });
}

export async function createEnrollmentToken(
  ctx: AppContext,
  input: { ttlSeconds: number; note?: string | undefined },
  actorId: string,
) {
  const token = generateSecret('enroll');
  const { rows } = await ctx.db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO enrollment_tokens (token_hash, created_by, note, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id, expires_at`,
    [hashSecret(token), actorId, input.note ?? null, input.ttlSeconds],
  );
  const row = rows[0]!;
  await audit(ctx.db, {
    actorType: 'user',
    actorId,
    action: 'enrollment_token.create',
    targetType: 'enrollment_token',
    targetId: row.id,
  });
  return { id: row.id, token, expiresAt: row.expires_at.toISOString() };
}
