// Two-step verification for accounts (TOTP). Turned on per account; staff must have it
// when REQUIRE_STAFF_MFA. Once on, actions that create credentials (API tokens, users,
// connection codes) or credits also need a fresh code from the authenticator app, so a
// stolen API token alone cannot mint itself a replacement.
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppContext } from '../../context.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import type { Redis } from '../../redis/client.js';
import { audit } from '../../audit.js';
import { AppError, conflict, unauthorized } from '../../errors.js';
import { base32Encode, matchTotp, newTotpSecret, openSecret, otpauthUrl, sealSecret, totpKey } from '../../auth/totp.js';

/** Header carrying the code for actions that need it. */
export const OTP_HEADER = 'x-ghost-otp';
/** Wrong codes allowed per account in FAIL_WINDOW_SECONDS before codes are refused. */
export const MAX_FAILURES = 5;
export const FAIL_WINDOW_SECONDS = 15 * 60;

export const mfaRequired = () =>
  new AppError(401, 'MFA_REQUIRED', `This action needs a code from your authenticator app (header ${OTP_HEADER})`);

type MfaContext = { db: Db; redis: Redis; config: Pick<Config, 'WORKER_TOKEN_SECRET'> };

export class MfaService {
  private readonly key: Buffer;
  constructor(private readonly ctx: MfaContext) {
    this.key = totpKey(ctx.config.WORKER_TOKEN_SECRET);
  }

  async status(userId: string) {
    const { rows } = await this.ctx.db.query(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]);
    const at: Date | null = rows[0]?.totp_enabled_at ?? null;
    return { enabled: at !== null, enabledAt: at?.toISOString() ?? null };
  }

  /** New secret for the authenticator app; takes effect once a code from it is confirmed. */
  async begin(userId: string) {
    const { rows } = await this.ctx.db.query(`SELECT email, totp_enabled_at FROM users WHERE id = $1`, [userId]);
    if (rows[0].totp_enabled_at) throw conflict('Two-step verification is already on; turn it off first to change devices');
    const secret = newTotpSecret();
    await this.ctx.db.query(`UPDATE users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1`, [userId, sealSecret(secret, this.key)]);
    return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, rows[0].email) };
  }

  async confirm(userId: string, code: string) {
    const { rows } = await this.ctx.db.query(`SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1`, [userId]);
    if (rows[0].totp_enabled_at) throw conflict('Two-step verification is already on');
    if (!rows[0].totp_secret) throw conflict('Start with POST /v1/me/mfa/totp');
    await this.check(userId, code, rows[0].totp_secret);
    await this.ctx.db.query(`UPDATE users SET totp_enabled_at = now() WHERE id = $1`, [userId]);
    await audit(this.ctx.db, { actorType: 'user', actorId: userId, action: 'mfa.enable', targetType: 'user', targetId: userId });
    return this.status(userId);
  }

  async disable(userId: string, code: string | undefined) {
    await this.verify(userId, code);
    await this.ctx.db.query(`UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [userId]);
    await audit(this.ctx.db, { actorType: 'user', actorId: userId, action: 'mfa.disable', targetType: 'user', targetId: userId });
    return this.status(userId);
  }

  /** For actions that need a second factor: passes when MFA is off, else needs a valid code. */
  async verify(userId: string, code: string | undefined) {
    const { rows } = await this.ctx.db.query(`SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1`, [userId]);
    if (!rows[0]?.totp_enabled_at) return;
    if (!code) throw mfaRequired();
    await this.check(userId, code, rows[0].totp_secret);
  }

  /** A code is valid once, within ±30 s, and only MAX_FAILURES wrong ones per window. */
  private async check(userId: string, code: string, sealed: Buffer) {
    const fails = `mfa:fail:${userId}`;
    if (Number(await this.ctx.redis.get(fails)) >= MAX_FAILURES)
      throw new AppError(429, 'MFA_LOCKED', `Too many wrong codes; try again in ${FAIL_WINDOW_SECONDS / 60} minutes`);
    const step = matchTotp(openSecret(sealed, this.key), code.trim(), Date.now());
    // The update also refuses a code already used (same or earlier step): no replay.
    const ok =
      step !== null &&
      (
        await this.ctx.db.query(
          `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
          [userId, step],
        )
      ).rowCount === 1;
    if (!ok) {
      const n = await this.ctx.redis.incr(fails);
      if (n === 1) await this.ctx.redis.expire(fails, FAIL_WINDOW_SECONDS);
      await audit(this.ctx.db, { actorType: 'user', actorId: userId, action: 'mfa.failure', targetType: 'user', targetId: userId });
      throw new AppError(401, 'MFA_INVALID', 'Wrong or already used code');
    }
    await this.ctx.redis.del(fails);
  }
}

/**
 * Server-side recovery (lost phone), for whoever runs the server: turns it off; the
 * account then turns it on again with a new phone. Needs only the database.
 */
export async function resetMfa(db: Db, email: string): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE email = $1 RETURNING id`,
    [email],
  );
  if (!rows[0]) return null;
  await audit(db, { actorType: 'system', action: 'mfa.reset', targetType: 'user', targetId: rows[0].id });
  return rows[0].id as string;
}

/** preHandler for actions that create credentials or credits: a fresh code when MFA is on. */
export function requireSecondFactor(ctx: AppContext): preHandlerAsyncHookHandler {
  const svc = new MfaService(ctx);
  return async (req: FastifyRequest) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw unauthorized();
    const h = req.headers[OTP_HEADER];
    await svc.verify(p.userId, typeof h === 'string' ? h : undefined);
  };
}
