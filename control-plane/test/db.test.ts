import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';

const db = createPool(process.env.DATABASE_URL!);
afterAll(() => db.end());

describe('config', () => {
  it('parses test env', () => {
    const cfg = loadConfig();
    expect(cfg.PORT).toBe(8080);
    expect(cfg.SCHEDULER_ENABLED).toBe(false);
  });

  it('rejects missing secrets', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://x' })).toThrow(
      /WORKER_TOKEN_SECRET/,
    );
  });
});

describe('migrations', () => {
  it('applies and is idempotent', async () => {
    await migrate(db);
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['users', 'workers', 'jobs', 'tasks', 'leases', 'task_events', 'audit_log']),
    );
  });

  it('allows only one active lease per task', async () => {
    await migrate(db);
    const u = await db.query(`INSERT INTO users (email, role) VALUES ('m@x', 'admin') RETURNING id`);
    const w = await db.query(`INSERT INTO workers (name, secret_hash) VALUES ('w', '\\x00') RETURNING id`);
    const j = await db.query(
      `INSERT INTO jobs (name, module_name, module_version, total_tasks, created_by)
       VALUES ('j', 'm', '1', 1, $1) RETURNING id`,
      [u.rows[0].id],
    );
    const t = await db.query(`INSERT INTO tasks (job_id, idx) VALUES ($1, 0) RETURNING id`, [j.rows[0].id]);
    const ins = () =>
      db.query(`INSERT INTO leases (task_id, worker_id, expires_at) VALUES ($1, $2, now())`, [
        t.rows[0].id,
        w.rows[0].id,
      ]);
    await ins();
    await expect(ins()).rejects.toThrow(/leases_one_active_per_task/);
    await db.query(`TRUNCATE users, workers, jobs CASCADE`);
  });
});
