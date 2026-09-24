/**
 * Bootstraps the first admin. Prints the API token once; only its hash is stored.
 * Usage: npm run create-admin -- admin@example.com
 */
import { z } from 'zod';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createUserWithToken } from '../modules/admin/service.js';
import type { AppContext } from '../context.js';

const email = z.email().safeParse(process.argv[2]);
// Same rule as the server's config (only this value is needed here, not the whole config).
const grant = z.coerce
  .number()
  .int()
  .min(0)
  .max(1_000_000_000)
  .default(1000)
  .safeParse(process.env.CREDITS_INITIAL_GRANT);
const url = process.env.DATABASE_URL;
if (!email.success || !url || !grant.success) {
  console.error('Usage: DATABASE_URL=... [CREDITS_INITIAL_GRANT=1000] create-admin <email>');
  process.exit(1);
}
const db = createPool(url);
try {
  await migrate(db);
  const { userId, token } = await createUserWithToken(
    { db } as AppContext,
    { email: email.data, role: 'admin', tokenName: 'bootstrap' },
    null,
    grant.data,
  );
  console.log(`admin user: ${userId}\napi token (shown once): ${token}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
