// Read models for the admin dashboard: current state, history and errors.
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { mergeBuckets, percentile } from './http-metrics.js';

export const RANGES = { '1h': [3600, 60], '6h': [6 * 3600, 300], '24h': [86400, 900], '7d': [7 * 86400, 3600] } as const;
export type Range = keyof typeof RANGES;

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Traffic of the last `minutes` minutes, all instances. */
async function apiWindow(ctx: AppContext, minutes: number) {
  const { rows } = await ctx.db.query<{ requests: number; e4: number; e5: number; buckets: number[] }>(
    `SELECT requests, errors_4xx AS e4, errors_5xx AS e5, buckets FROM api_metrics
      WHERE minute >= date_trunc('minute', now()) - make_interval(mins => $1)`,
    [minutes],
  );
  const buckets = mergeBuckets(rows.map((r) => r.buckets));
  const requests = rows.reduce((a, r) => a + r.requests, 0);
  const e5 = rows.reduce((a, r) => a + r.e5, 0);
  return {
    requests,
    requestsPerMinute: Math.round((requests / minutes) * 10) / 10,
    errors4xx: rows.reduce((a, r) => a + r.e4, 0),
    errors5xx: e5,
    errorRate: requests ? Math.round((e5 / requests) * 10000) / 10000 : 0,
    latencyP50Ms: percentile(buckets, 0.5),
    latencyP95Ms: percentile(buckets, 0.95),
    latencyP99Ms: percentile(buckets, 0.99),
  };
}

function workerRow(r: Record<string, any>, now: Date) {
  const online = r.state !== 'offline' && r.status === 'active';
  const hw = r.hardware ?? {};
  const u = r.last_usage ?? {};
  const p = r.profile ?? null;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    state: r.state,
    online,
    agentVersion: r.agent_version,
    lastSeenAt: iso(r.last_seen_at),
    heartbeatAgeS: r.last_seen_at ? Math.round((now.getTime() - r.last_seen_at.getTime()) / 1000) : null,
    uptimeS: online && r.online_since ? Math.round((now.getTime() - r.online_since.getTime()) / 1000) : null,
    hardware: {
      cpu: hw.cpu?.model ?? null,
      cores: hw.cpu?.cores ?? null,
      threads: hw.cpu?.threads ?? null,
      ramMb: hw.ramMb ?? null,
      gpus: (hw.gpus ?? []).map((g: any) => ({ name: g.name, vendor: g.vendor ?? null, vramMb: g.vramMb ?? null })),
      os: hw.os ? `${hw.os.name} ${hw.os.version}` : null,
    },
    capacity: r.capacity ?? null,
    usage: {
      cpuPercent: num(u.cpuPercent),
      ghostCpuPercent: num(u.cpuGhostPercent),
      ramUsedMb: num(u.ramUsedMb),
      ramGhostMb: num(u.ramGhostMb),
      gpuPercent: num(u.gpuPercent),
      temperatureC: num(u.temperatureC),
    },
    performance: p
      ? {
          verified: r.verified,
          overall: p.scores?.overall ?? null,
          cpu: p.scores?.cpu ?? null,
          gpu: p.scores?.gpu ?? null,
          inferenceItemsPerSec: p.inference?.itemsPerSec ?? null,
          latencyMs: p.network?.latencyMs?.median ?? null,
          calibratedAt: iso(r.calibrated_at),
        }
      : null,
    activeJobs: r.active ?? 0,
    last24h: { completed: r.completed_24h ?? 0, failed: r.failed_24h ?? 0 },
  };
}

const WORKER_SQL = `
  SELECT w.*, p.profile, p.verified, p.calibrated_at,
         (SELECT count(*)::int FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('assigned', 'running')) AS active,
         (SELECT count(*)::int FROM job_assignments a WHERE a.worker_id = w.id AND a.status = 'completed'
             AND a.finished_at > now() - interval '24 hours') AS completed_24h,
         (SELECT count(*)::int FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('failed', 'lost', 'timeout', 'expired')
             AND a.finished_at > now() - interval '24 hours') AS failed_24h
    FROM workers w LEFT JOIN worker_performance p ON p.worker_id = w.id`;

export class DashboardService {
  constructor(private readonly ctx: AppContext) {}

  async overview() {
    const db = this.ctx.db;
    const now = new Date();
    const net = (
      await db.query(
        `SELECT COALESCE(sum(n) FILTER (WHERE state <> 'offline'), 0)::int AS online,
                COALESCE(sum(n) FILTER (WHERE state = 'offline'), 0)::int AS offline,
                COALESCE(jsonb_object_agg(state, n), '{}') AS by_state
           FROM (SELECT state, count(*)::int AS n FROM workers WHERE status = 'active' GROUP BY state) s`,
      )
    ).rows[0];
    const totals = (
      await db.query(
        `SELECT COALESCE(sum((capacity->>'cpuCores')::float), 0) AS cpu_offered,
                COALESCE(sum((hardware->'cpu'->>'threads')::int), 0)::int AS cpu_threads,
                COALESCE(sum((capacity->>'ramMb')::bigint), 0) AS ram_offered,
                COALESCE(sum((hardware->>'ramMb')::bigint), 0) AS ram_installed,
                COALESCE(sum(jsonb_array_length(COALESCE(hardware->'gpus', '[]'))), 0)::int AS gpus_installed,
                COALESCE(sum(CASE WHEN (capacity->>'gpuPercent')::float > 0 THEN jsonb_array_length(COALESCE(hardware->'gpus', '[]')) ELSE 0 END), 0)::int AS gpus_shared,
                COALESCE(sum((capacity->>'vramMb')::bigint), 0) AS vram_offered,
                COALESCE(sum((SELECT COALESCE(sum((g->>'vramMb')::bigint), 0) FROM jsonb_array_elements(COALESCE(hardware->'gpus', '[]')) g)), 0) AS vram_installed
           FROM workers WHERE status = 'active' AND state <> 'offline'`,
      )
    ).rows[0];
    const jobs = (
      await db.query(
        `SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
                count(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned,
                count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                count(*) FILTER (WHERE status = 'TIMEOUT')::int AS timeout,
                count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                count(*) FILTER (WHERE status = 'COMPLETED' AND finished_at > now() - interval '1 hour')::int AS completed_1h,
                count(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT') AND finished_at > now() - interval '1 hour')::int AS failed_1h
           FROM jobs`,
      )
    ).rows[0];
    const pending = await db.query(
      `SELECT pending_reason, count(*)::int AS n FROM jobs WHERE status = 'QUEUED' AND pending_reason IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
    );
    const attempts = (
      await db.query(
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS ok,
                count(*) FILTER (WHERE status IN ('failed', 'lost', 'timeout', 'expired'))::int AS bad
           FROM job_assignments WHERE finished_at > now() - interval '1 hour'`,
      )
    ).rows[0];
    return {
      generatedAt: now.toISOString(),
      network: {
        workersOnline: net.online,
        workersOffline: net.offline,
        workersByState: net.by_state,
        cpu: { offeredCores: Math.round(totals.cpu_offered * 10) / 10, threads: totals.cpu_threads },
        ram: { offeredMb: Number(totals.ram_offered), installedMb: Number(totals.ram_installed) },
        gpu: { shared: totals.gpus_shared, installed: totals.gpus_installed },
        vram: { offeredMb: Number(totals.vram_offered), installedMb: Number(totals.vram_installed) },
      },
      jobs: {
        queued: jobs.queued,
        assigned: jobs.assigned,
        running: jobs.running,
        completed: jobs.completed,
        failed: jobs.failed,
        timeout: jobs.timeout,
        cancelled: jobs.cancelled,
        lastHour: { completed: jobs.completed_1h, failed: jobs.failed_1h },
        pendingReasons: pending.rows.map((r) => ({ reason: r.pending_reason, jobs: r.n })),
      },
      system: {
        api: await apiWindow(this.ctx, 5),
        attemptsLastHour: {
          completed: attempts.ok,
          failed: attempts.bad,
          failureRate: attempts.ok + attempts.bad ? Math.round((attempts.bad / (attempts.ok + attempts.bad)) * 1000) / 1000 : 0,
        },
        throughputPerMinute: Math.round((jobs.completed_1h / 60) * 100) / 100,
      },
      recentErrors: (await this.errors({ limit: 10 })).items,
    };
  }

  async history(range: Range) {
    const [span, step] = RANGES[range];
    const db = this.ctx.db;
    const net = await db.query(
      `SELECT date_bin(make_interval(secs => $2), ts, 'epoch') AS t,
              avg(workers_online)::float AS online, avg(workers_offline)::float AS offline,
              avg(cpu_cores)::float AS cpu, avg(ram_mb)::float AS ram, avg(gpus)::float AS gpus, avg(vram_mb)::float AS vram,
              avg(jobs_queued)::float AS queued, avg(jobs_running)::float AS running,
              sum(jobs_completed)::int AS completed, sum(jobs_failed)::int AS failed,
              avg(queue_wait_p50_s)::float AS wait_p50, max(queue_wait_p95_s)::float AS wait_p95
         FROM network_metrics WHERE ts > now() - make_interval(secs => $1)
        GROUP BY 1 ORDER BY 1`,
      [span, step],
    );
    const api = await db.query<{ t: Date; requests: number; e5: number; e4: number; buckets: number[][] }>(
      `SELECT date_bin(make_interval(secs => $2), minute, 'epoch') AS t,
              sum(requests)::int AS requests, sum(errors_5xx)::int AS e5, sum(errors_4xx)::int AS e4,
              array_agg(buckets) AS buckets
         FROM api_metrics WHERE minute > now() - make_interval(secs => $1)
        GROUP BY 1 ORDER BY 1`,
      [span, step],
    );
    const perMin = step / 60;
    return {
      range,
      stepSeconds: step,
      network: net.rows.map((r) => ({
        t: r.t.toISOString(),
        workersOnline: round1(r.online),
        workersOffline: round1(r.offline),
        cpuCores: round1(r.cpu),
        ramMb: Math.round(r.ram),
        gpus: round1(r.gpus),
        vramMb: Math.round(r.vram),
        jobsQueued: round1(r.queued),
        jobsRunning: round1(r.running),
        completedPerMin: round1(r.completed / perMin),
        failedPerMin: round1(r.failed / perMin),
        queueWaitP50S: r.wait_p50 === null ? null : round1(r.wait_p50),
        queueWaitP95S: r.wait_p95 === null ? null : round1(r.wait_p95),
      })),
      api: api.rows.map((r) => {
        // array_agg of arrays yields a 2-D array; pg returns it as nested arrays.
        const b = mergeBuckets(r.buckets);
        return {
          t: r.t.toISOString(),
          requestsPerMin: round1(r.requests / perMin),
          errors5xxPerMin: round1(r.e5 / perMin),
          errors4xxPerMin: round1(r.e4 / perMin),
          latencyP50Ms: percentile(b, 0.5),
          latencyP95Ms: percentile(b, 0.95),
        };
      }),
    };
  }

  async workers() {
    const now = new Date();
    const { rows } = await this.ctx.db.query(`${WORKER_SQL} WHERE w.status = 'active' ORDER BY w.state = 'offline', w.name`);
    return { items: rows.map((r) => workerRow(r, now)) };
  }

  async worker(id: string, range: Range) {
    const db = this.ctx.db;
    const now = new Date();
    const r = (await db.query(`${WORKER_SQL} WHERE w.id = $1`, [id])).rows[0];
    if (!r) throw notFound('Worker');
    const [span, step] = RANGES[range];
    const series = await db.query(
      `SELECT date_bin(make_interval(secs => $3), ts, 'epoch') AS t,
              avg(cpu_percent)::float AS cpu, avg(cpu_ghost_percent)::float AS ghost,
              avg(ram_used_mb)::float AS ram, avg(ram_ghost_mb)::float AS ram_ghost,
              avg(gpu_percent)::float AS gpu, avg(temperature_c)::float AS temp, max(temperature_c)::float AS temp_max,
              avg(active_assignments)::float AS active,
              count(*) FILTER (WHERE state IN ('available', 'running'))::float / count(*) AS sharing
         FROM worker_metrics WHERE worker_id = $1 AND ts > now() - make_interval(secs => $2)
        GROUP BY 1 ORDER BY 1`,
      [id, span, step],
    );
    const assignments = await db.query(
      `SELECT a.id, a.job_id, j.name, j.type, a.attempt, a.status, a.assigned_at, a.started_at, a.finished_at, a.error, a.score
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.worker_id = $1 ORDER BY a.assigned_at DESC LIMIT 50`,
      [id],
    );
    const decisions = await db.query(
      `SELECT job_id, score, summary, created_at FROM scheduler_decisions WHERE worker_id = $1 ORDER BY id DESC LIMIT 20`,
      [id],
    );
    const perf = await db.query(`SELECT profile, observed, verified, calibrated_at FROM worker_performance WHERE worker_id = $1`, [id]);
    const calibrations = await db.query(
      `SELECT id, reason, status, requested_at, completed_at, issues, error FROM worker_calibrations
        WHERE worker_id = $1 ORDER BY requested_at DESC LIMIT 10`,
      [id],
    );
    const events = await db.query(
      `SELECT e.id, e.job_id, e.type, e.payload, e.created_at FROM job_events e WHERE e.worker_id = $1 ORDER BY e.id DESC LIMIT 50`,
      [id],
    );
    return {
      worker: workerRow(r, now),
      raw: { hardware: r.hardware, capacity: r.capacity, lastUsage: r.last_usage, workloadTypes: r.workload_types, maxConcurrentTasks: r.max_concurrent_tasks, createdAt: iso(r.created_at), revokedAt: iso(r.revoked_at), revokedReason: r.revoked_reason },
      profile: perf.rows[0]?.profile ?? null,
      observed: perf.rows[0]?.observed ?? {},
      calibrations: calibrations.rows.map((c) => ({ id: c.id, reason: c.reason, status: c.status, requestedAt: iso(c.requested_at), completedAt: iso(c.completed_at), issues: c.issues ?? [], error: c.error })),
      history: {
        range,
        stepSeconds: step,
        points: series.rows.map((s) => ({
          t: s.t.toISOString(),
          cpuPercent: s.cpu === null ? null : round1(s.cpu),
          ghostCpuPercent: s.ghost === null ? null : round1(s.ghost),
          ramUsedMb: s.ram === null ? null : Math.round(s.ram),
          ramGhostMb: s.ram_ghost === null ? null : Math.round(s.ram_ghost),
          gpuPercent: s.gpu === null ? null : round1(s.gpu),
          temperatureC: s.temp === null ? null : round1(s.temp),
          temperatureMaxC: s.temp_max === null ? null : round1(s.temp_max),
          activeJobs: round1(s.active),
          sharingFraction: round1(s.sharing),
        })),
      },
      assignments: assignments.rows.map((a) => ({
        id: a.id,
        jobId: a.job_id,
        jobName: a.name,
        type: a.type,
        attempt: a.attempt,
        status: a.status,
        assignedAt: iso(a.assigned_at),
        startedAt: iso(a.started_at),
        finishedAt: iso(a.finished_at),
        durationS: a.started_at && a.finished_at ? Math.round((a.finished_at - a.started_at) / 100) / 10 : null,
        error: a.error,
        score: a.score,
      })),
      decisions: decisions.rows.map((d) => ({ jobId: d.job_id, score: d.score, summary: d.summary, at: iso(d.created_at) })),
      events: events.rows.map((e) => ({ id: Number(e.id), jobId: e.job_id, type: e.type, payload: e.payload, at: iso(e.created_at) })),
    };
  }

  /** Everything that went wrong, newest first: server errors, failed attempts, failed calibrations. */
  async errors(f: { limit: number; kind?: string | undefined; workerId?: string | undefined }) {
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM (
         SELECT 'api' AS kind, ts AS at, NULL::uuid AS worker_id, NULL::text AS worker_name, NULL::uuid AS job_id,
                method || ' ' || route AS source, status::text AS code, message, request_id AS ref
           FROM api_errors
         UNION ALL
         SELECT 'attempt', a.finished_at, a.worker_id, w.name, a.job_id, j.type || ' · ' || COALESCE(j.name, ''), a.status, a.error, a.id::text
           FROM job_assignments a JOIN jobs j ON j.id = a.job_id JOIN workers w ON w.id = a.worker_id
          WHERE a.status IN ('failed', 'lost', 'timeout', 'expired') AND a.finished_at IS NOT NULL
         UNION ALL
         SELECT 'calibration', COALESCE(c.completed_at, c.requested_at), c.worker_id, w.name, NULL, 'calibration · ' || c.reason, c.status,
                COALESCE(c.error, '') || CASE WHEN c.issues IS NOT NULL AND jsonb_array_length(c.issues) > 0 THEN ' ' || c.issues::text ELSE '' END,
                c.id::text
           FROM worker_calibrations c JOIN workers w ON w.id = c.worker_id WHERE c.status IN ('FAILED', 'EXPIRED')
       ) e
       WHERE ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR worker_id = $3)
       ORDER BY at DESC LIMIT $1`,
      [f.limit, f.kind ?? null, f.workerId ?? null],
    );
    return {
      items: rows.map((r) => ({
        kind: r.kind,
        at: iso(r.at),
        workerId: r.worker_id,
        workerName: r.worker_name,
        jobId: r.job_id,
        source: r.source,
        code: r.code,
        message: r.message,
        ref: r.ref,
      })),
    };
  }
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
