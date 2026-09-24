// Provider reputation from objective, server-observed metrics only.
//
// There is no rating, review, like or comment anywhere in the platform, and nothing a
// provider or customer writes enters this computation. Inputs:
//   - jobs completed        (assignments the worker finished, for other people's jobs)
//   - failure rate          (failed + timeout + lost + expired over finished attempts)
//   - uptime                (minutes offering work, from heartbeats received)
//   - mean response time    (assigned → accepted, server clock on both ends)
// Jobs whose customer also owns the worker are ignored (self-dealing cannot build reputation).
import type pg from 'pg';

/** Attempts and responses counted over this window. */
export const REPUTATION_WINDOW_DAYS = 30;
/** Uptime is measured over this window (heartbeat samples are kept 7 days). */
export const UPTIME_WINDOW_DAYS = 7;
/** Response time at which the responsiveness component is 0.5. */
export const RESPONSE_REF_SECONDS = 10;
/** Completed jobs for full experience (log scale): 1 → 0.1, 10 → 0.35, 1000 → 1. */
export const EXPERIENCE_FULL_JOBS = 1000;

export const REPUTATION_WEIGHTS = { reliability: 0.4, uptime: 0.25, responsiveness: 0.15, experience: 0.2 } as const;

export interface ReputationMetrics {
  completed: number;
  failed: number;
  /** Minutes offering work in the uptime window / minutes in that window since registration. */
  uptimeMinutes: number;
  uptimeWindowMinutes: number;
  /** Mean assigned → accepted, seconds; null if it never accepted a job. */
  avgResponseSeconds: number | null;
  /** Distinct customers served (context only, not in the score). */
  customers: number;
}

export interface Reputation {
  /** 0 … 1000. */
  score: number;
  components: { reliability: number; uptime: number; responsiveness: number; experience: number };
  metrics: ReputationMetrics & { failureRate: number | null; uptime: number | null };
  formula: string;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Pure and deterministic. A newcomer with no history scores 275 + 250 × its uptime. */
export function computeReputation(m: ReputationMetrics): Reputation {
  const attempts = m.completed + m.failed;
  // Laplace-smoothed: one failure out of one attempt is not "0% reliable".
  const reliability = (m.completed + 1) / (attempts + 2);
  const uptime = m.uptimeWindowMinutes > 0 ? clamp01(m.uptimeMinutes / m.uptimeWindowMinutes) : 0;
  const responsiveness = m.avgResponseSeconds === null ? 0.5 : RESPONSE_REF_SECONDS / (RESPONSE_REF_SECONDS + Math.max(0, m.avgResponseSeconds));
  const experience = clamp01(Math.log10(1 + m.completed) / Math.log10(1 + EXPERIENCE_FULL_JOBS));
  const components = { reliability: r3(reliability), uptime: r3(uptime), responsiveness: r3(responsiveness), experience: r3(experience) };
  const W = REPUTATION_WEIGHTS;
  const score = Math.round(
    1000 * (W.reliability * components.reliability + W.uptime * components.uptime + W.responsiveness * components.responsiveness + W.experience * components.experience),
  );
  return {
    score,
    components,
    metrics: {
      ...m,
      avgResponseSeconds: m.avgResponseSeconds === null ? null : r3(m.avgResponseSeconds),
      failureRate: attempts ? r3(m.failed / attempts) : null,
      uptime: m.uptimeWindowMinutes > 0 ? r3(uptime) : null,
    },
    formula: '1000 × (0.40 reliability + 0.25 uptime + 0.15 responsiveness + 0.20 experience)',
  };
}

/** Metrics for many workers in one query (all from server-side records). */
export async function loadReputations(db: pg.Pool | pg.PoolClient, workerIds?: string[]): Promise<Map<string, Reputation>> {
  const { rows } = await db.query<{
    id: string;
    completed: number;
    failed: number;
    customers: number;
    avg_response: number | null;
    uptime_minutes: number;
    window_minutes: number;
  }>(
    `SELECT w.id,
            COALESCE(a.completed, 0) AS completed, COALESCE(a.failed, 0) AS failed, COALESCE(a.customers, 0) AS customers,
            a.avg_response,
            COALESCE(m.n, 0) AS uptime_minutes,
            GREATEST(0, floor(EXTRACT(EPOCH FROM now() - GREATEST(w.created_at, now() - make_interval(days => $3))) / 60))::int AS window_minutes
       FROM workers w
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE x.status = 'completed')::int AS completed,
                count(*) FILTER (WHERE x.status IN ('failed', 'timeout', 'lost', 'expired'))::int AS failed,
                count(DISTINCT j.owner_id) FILTER (WHERE x.status = 'completed')::int AS customers,
                avg(EXTRACT(EPOCH FROM x.started_at - x.assigned_at)) FILTER (WHERE x.started_at IS NOT NULL)::float8 AS avg_response
           FROM job_assignments x JOIN jobs j ON j.id = x.job_id
          WHERE x.worker_id = w.id AND x.finished_at IS NOT NULL
            AND x.finished_at > now() - make_interval(days => $2)
            AND j.owner_id IS DISTINCT FROM w.owner_user_id
       ) a ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n FROM worker_metrics s
          WHERE s.worker_id = w.id AND s.ts > now() - make_interval(days => $3) AND s.state IN ('available', 'running')
       ) m ON true
      WHERE ($1::uuid[] IS NULL OR w.id = ANY($1::uuid[]))`,
    [workerIds ?? null, REPUTATION_WINDOW_DAYS, UPTIME_WINDOW_DAYS],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      computeReputation({
        completed: r.completed,
        failed: r.failed,
        customers: r.customers,
        avgResponseSeconds: r.avg_response,
        uptimeMinutes: r.uptime_minutes,
        uptimeWindowMinutes: r.window_minutes,
      }),
    ]),
  );
}
