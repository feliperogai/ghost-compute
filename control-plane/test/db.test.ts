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
      expect.arrayContaining(['users', 'workers', 'jobs', 'job_assignments', 'job_events', 'audit_log']),
    );
  });

  it('allows only one active assignment per job', async () => {
    await migrate(db);
    const u = await db.query(`INSERT INTO users (email, role) VALUES ('m@x', 'admin') RETURNING id`);
    const w = await db.query(`INSERT INTO workers (name, secret_hash) VALUES ('w', '\\x00') RETURNING id`);
    const j = await db.query(
      `INSERT INTO jobs (owner_id, type, resources, timeout_seconds, input) VALUES ($1, 'benchmark', '{}', 60, '{}') RETURNING id`,
      [u.rows[0].id],
    );
    const ins = () =>
      db.query(
        `INSERT INTO job_assignments (job_id, worker_id, attempt, strategy, score, score_detail, reserved, accept_deadline)
         VALUES ($1, $2, 1, 's', 0, '{}', '{}', now())`,
        [j.rows[0].id, w.rows[0].id],
      );
    await ins();
    await expect(ins()).rejects.toThrow(/job_assignments_one_active/);
    await expect(db.query(`UPDATE jobs SET status = 'DONE'`)).rejects.toThrow(/check/);
    await db.query(`TRUNCATE users, workers, jobs CASCADE`);
  });
});
