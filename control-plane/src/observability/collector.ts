// Once a minute (one instance at a time): a snapshot of the whole network for the
// dashboard's history, plus retention of every time series.
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';

const LOCK_KEY = 'ghost:metrics:collector';
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
export const RETENTION_DAYS = 7;
const ERROR_LOG_KEEP = 5000;

/** Writes one network_metrics row for the minute ending at `at` (idempotent per minute). */
export async function collectNetwork(ctx: AppContext, at = new Date()) {
  const ts = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  await ctx.db.query(
    `WITH w AS (
       SELECT state,
              COALESCE((capacity->>'cpuCores')::float, 0) AS cpu,
              COALESCE((capacity->>'ramMb')::bigint, 0) AS ram,
              COALESCE((capacity->>'vramMb')::bigint, 0) AS vram,
              CASE WHEN COALESCE((capacity->>'gpuPercent')::float, 0) > 0
                   THEN COALESCE(jsonb_array_length(hardware->'gpus'), 0) ELSE 0 END AS gpus
         FROM workers WHERE status = 'active'
     ), j AS (
       SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
              count(*) FILTER (WHERE status IN ('ASSIGNED', 'RUNNING'))::int AS running,
              count(*) FILTER (WHERE status = 'COMPLETED' AND finished_at > $1::timestamptz - interval '1 minute' AND finished_at <= $1)::int AS completed,
              count(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT') AND finished_at > $1::timestamptz - interval '1 minute' AND finished_at <= $1)::int AS failed
         FROM jobs
     ), q AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.assigned_at - j.created_at)) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM a.assigned_at - j.created_at)) AS p95
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.attempt = 1 AND a.assigned_at > $1::timestamptz - interval '1 minute' AND a.assigned_at <= $1
     )
     INSERT INTO network_metrics (ts, workers_online, workers_offline, workers_by_state, cpu_cores, ram_mb, gpus, vram_mb,
                                  jobs_queued, jobs_running, jobs_completed, jobs_failed, queue_wait_p50_s, queue_wait_p95_s)
     SELECT $1,
            (SELECT count(*) FROM w WHERE state <> 'offline')::int,
            (SELECT count(*) FROM w WHERE state = 'offline')::int,
            COALESCE((SELECT jsonb_object_agg(state, n) FROM (SELECT state, count(*) AS n FROM w GROUP BY state) s), '{}'::jsonb),
            COALESCE((SELECT sum(cpu) FROM w WHERE state <> 'offline'), 0),
            COALESCE((SELECT sum(ram) FROM w WHERE state <> 'offline'), 0),
            COALESCE((SELECT sum(gpus) FROM w WHERE state <> 'offline'), 0)::int,
            COALESCE((SELECT sum(vram) FROM w WHERE state <> 'offline'), 0),
            j.queued, j.running, j.completed, j.failed, q.p50, q.p95
       FROM j, q
     ON CONFLICT (ts) DO NOTHING`,
    [ts],
  );
}

export async function prune(ctx: AppContext) {
  const cutoff = `now() - make_interval(days => ${RETENTION_DAYS})`;
  await ctx.db.query(`DELETE FROM worker_metrics WHERE ts < ${cutoff}`);
  await ctx.db.query(`DELETE FROM network_metrics WHERE ts < ${cutoff}`);
  await ctx.db.query(`DELETE FROM api_metrics WHERE minute < ${cutoff}`);
  await ctx.db.query(`DELETE FROM api_errors WHERE id < (SELECT id FROM api_errors ORDER BY id DESC OFFSET $1 LIMIT 1)`, [ERROR_LOG_KEEP]);
}

export class MetricsCollector {
  private readonly id = randomUUID();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    const tick = async () => {
      try {
        // Leader for this minute only: the lock expires on its own.
        if ((await this.ctx.redis.set(LOCK_KEY, this.id, 'PX', 55_000, 'NX')) === 'OK') {
          await collectNetwork(this.ctx);
          await prune(this.ctx);
        }
      } catch (err) {
        this.log.warn({ err }, 'metrics collection failed');
      }
    };
    // Aligned to the minute so rows line up across restarts.
    const first = 60_000 - (Date.now() % 60_000) + 1_000;
    this.timer = setTimeout(() => {
      void tick();
      this.timer = setInterval(() => void tick(), 60_000);
    }, first);
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ctx.redis.eval(RELEASE_LUA, 1, LOCK_KEY, this.id).catch(() => {});
  }
}
