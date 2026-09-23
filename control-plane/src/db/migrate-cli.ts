import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createPool(url);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema up to date');
} finally {
  await db.end();
}
