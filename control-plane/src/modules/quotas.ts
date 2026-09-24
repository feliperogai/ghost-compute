// Per-account limits for public accounts (members). Staff are not limited here.
// Callers run inside a transaction: the user row lock serializes concurrent requests of
// one account, so two parallel calls cannot both squeeze under the limit.
import type pg from 'pg';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { isStaff, type Role } from '../auth/plugin.js';

export const quotaExceeded = (what: string, limit: number) =>
  new AppError(429, 'QUOTA_EXCEEDED', `Account limit reached: ${what} (${limit})`, { what, limit });

async function lockAccount(c: pg.PoolClient, userId: string) {
  await c.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
}

/** Jobs not yet finished, including `adding` new ones. */
export async function checkActiveJobs(ctx: AppContext, c: pg.PoolClient, userId: string, role: Role, adding: number) {
  if (isStaff(role)) return;
  await lockAccount(c, userId);
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE owner_id = $1 AND status IN ('QUEUED', 'ASSIGNED', 'RUNNING')`,
    [userId],
  );
  if (rows[0]!.n + adding > ctx.config.MEMBER_MAX_ACTIVE_JOBS) throw quotaExceeded('active jobs', ctx.config.MEMBER_MAX_ACTIVE_JOBS);
}

export async function checkDatasets(ctx: AppContext, c: pg.PoolClient, userId: string, role: Role) {
  if (isStaff(role)) return;
  await lockAccount(c, userId);
  const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM datasets WHERE owner_id = $1`, [userId]);
  if (rows[0]!.n + 1 > ctx.config.MEMBER_MAX_DATASETS) throw quotaExceeded('datasets', ctx.config.MEMBER_MAX_DATASETS);
}

export async function checkStorage(ctx: AppContext, c: pg.PoolClient, userId: string, role: Role, adding: number) {
  if (isStaff(role)) return;
  await lockAccount(c, userId);
  const { rows } = await c.query<{ b: string }>(`SELECT COALESCE(sum(total_bytes), 0)::text AS b FROM datasets WHERE owner_id = $1`, [
    userId,
  ]);
  if (Number(rows[0]!.b) + adding > ctx.config.MEMBER_STORAGE_BYTES) throw quotaExceeded('image storage bytes', ctx.config.MEMBER_STORAGE_BYTES);
}
