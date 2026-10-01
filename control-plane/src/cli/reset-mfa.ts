/**
 * Turns off two-step verification for an account whose phone was lost. Run on the
 * server (database access is the proof of authority); the account turns it on again.
 * Usage: npm run reset-mfa -- user@example.com
 */
import { z } from 'zod';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { resetMfa } from '../modules/account/mfa.js';

const email = z.email().safeParse(process.argv[2]);
const url = process.env.DATABASE_URL;
if (!email.success || !url) {
  console.error('Usage: DATABASE_URL=... reset-mfa <email>');
  process.exit(1);
}
const db = createPool(url);
try {
  await migrate(db);
  const id = await resetMfa(db, email.data);
  if (!id) {
    console.error(`no user with e-mail ${email.data}`);
    process.exitCode = 1;
  } else {
    console.log(`two-step verification is off for ${email.data} (${id}); turn it on again with POST /v1/me/mfa/totp`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
