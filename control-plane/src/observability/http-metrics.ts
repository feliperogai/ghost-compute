// Per-instance HTTP request statistics, aggregated per minute and flushed to Postgres.
// Latency is kept as a fixed histogram so several control-plane instances merge exactly.
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.js';

/** Upper bounds (ms) of the latency buckets; one more bucket catches everything slower. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
/** Paths that are not traffic (probes, long-lived sockets). */
const IGNORED = new Set(['/healthz', '/readyz', '/v1/ws']);
const MAX_ERROR_MESSAGE = 500;

interface MinuteStats {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  buckets: number[];
}

export function bucketIndex(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

/** Percentile from a merged histogram, interpolated inside the bucket. */
export function percentile(buckets: number[], q: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i]!;
    if (n > 0 && seen + n >= target) {
      const lo = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1]!;
      const hi = LATENCY_BUCKETS_MS[i] ?? LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]! * 2;
      return Math.round((lo + ((target - seen) / n) * (hi - lo)) * 10) / 10;
    }
    seen += n;
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]!;
}

export function mergeBuckets(rows: number[][]): number[] {
  const out = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) as number[];
  for (const r of rows) r.forEach((v, i) => (out[i] = (out[i] ?? 0) + v));
  return out;
}

const minuteOf = (t: number) => Math.floor(t / 60_000) * 60_000;

export class HttpMetrics {
  readonly instance = `${hostname()}:${process.pid}`;
  private readonly minutes = new Map<number, MinuteStats>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db) {}

  record(status: number, ms: number, at = Date.now()) {
    const m = minuteOf(at);
    let s = this.minutes.get(m);
    if (!s) this.minutes.set(m, (s = { requests: 0, errors4xx: 0, errors5xx: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) }));
    s.requests++;
    if (status >= 500) s.errors5xx++;
    else if (status >= 400) s.errors4xx++;
    s.buckets[bucketIndex(ms)]!++;
  }

  /** Writes what was counted since the last flush; rows are additive, so the current minute can be partial. */
  async flush() {
    for (const [m, s] of [...this.minutes]) {
      this.minutes.delete(m);
      await this.db
        .query(
          `INSERT INTO api_metrics (instance, minute, requests, errors_4xx, errors_5xx, buckets)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (minute, instance) DO UPDATE SET
             requests = api_metrics.requests + EXCLUDED.requests,
             errors_4xx = api_metrics.errors_4xx + EXCLUDED.errors_4xx,
             errors_5xx = api_metrics.errors_5xx + EXCLUDED.errors_5xx,
             buckets = (SELECT array_agg(a + b ORDER BY i)
                          FROM unnest(api_metrics.buckets, EXCLUDED.buckets) WITH ORDINALITY AS t(a, b, i))`,
          [this.instance, new Date(m), s.requests, s.errors4xx, s.errors5xx, s.buckets],
        )
        .catch(() => {});
    }
  }

  /** Hooks into Fastify: times every request, logs server errors with their request id. */
  register(app: FastifyInstance) {
    app.addHook('onError', async (req, _reply, err) => {
      (req as { ghostError?: { code?: string; message: string } }).ghostError = {
        code: (err as { code?: string }).code,
        message: err.message,
      };
    });
    app.addHook('onResponse', async (req, reply) => {
      const route = req.routeOptions.url ?? 'unmatched';
      if (IGNORED.has(route)) return;
      this.record(reply.statusCode, reply.elapsedTime);
      if (reply.statusCode >= 500) {
        const e = (req as { ghostError?: { code?: string; message: string } }).ghostError;
        await this.db
          .query(
            `INSERT INTO api_errors (method, route, status, request_id, code, message) VALUES ($1, $2, $3, $4, $5, $6)`,
            [req.method, route, reply.statusCode, req.id, e?.code ?? null, e?.message.slice(0, MAX_ERROR_MESSAGE) ?? null],
          )
          .catch(() => {});
      }
    });
    this.timer = setInterval(() => void this.flush(), 15_000);
    this.timer.unref();
    app.addHook('onClose', async () => {
      if (this.timer) clearInterval(this.timer);
      await this.flush();
    });
  }
}
