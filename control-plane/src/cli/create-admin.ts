/**
 * Bootstraps the first admin. Prints the API token once; only its hash is stored.
 * Usage: npm run create-admin -- admin@example.com
 */
import { z } from 'zod';
import { envSchema } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createUserWithToken } from '../modules/admin/service.js';

const email = z.email().safeParse(process.argv[2]);
// The server's own rules and defaults, for the settings creating a user reads (the CLI
// does not need the rest of the server's config, such as WORKER_TOKEN_SECRET).
const config = envSchema
  .pick({ DATABASE_URL: true, CREDITS_INITIAL_GRANT: true, MEMBER_TOKEN_TTL_DAYS: true, STAFF_TOKEN_TTL_DAYS: true })
  .safeParse(process.env);
if (!email.success || !config.success) {
  console.error('Usage: DATABASE_URL=... [CREDITS_INITIAL_GRANT=1000] [STAFF_TOKEN_TTL_DAYS=90] create-admin <email>');
  process.exit(1);
}
const url = config.data.DATABASE_URL;
const db = createPool(url);
try {
  await migrate(db);
  const { userId, token, expiresAt } = await createUserWithToken(
    { db, config: config.data },
    { email: email.data, role: 'admin', tokenName: 'bootstrap' },
    null,
  );
  console.log(`admin user: ${userId}\napi token (shown once): ${token}\nexpires: ${expiresAt} (mint the next one with POST /v1/me/tokens)`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
