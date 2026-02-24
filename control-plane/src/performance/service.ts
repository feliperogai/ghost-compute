// Calibration lifecycle: decide when a worker needs benchmarks, serve the network tests,
// verify the report, store the WorkerPerformanceProfile, and learn from real jobs.
import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { AppError, badRequest, notFound } from '../errors.js';
import type { PerformanceView } from '../scheduler/types.js';
import { buildProfile, summarize, type Observed, type ServerMeasured, type WorkerPerformanceProfile } from './profile.js';
import { sha256Hex, streamBytes, streamSha256 } from './stream.js';
import { DEFAULT_PARAMS, reportSchema, type CalibrationParams } from './suite.js';

/** How long a worker has to finish a calibration. */
const DEADLINE_SECONDS = 15 * 60;
/** Wait this long after a failed/expired calibration before asking again. */
const RETRY_AFTER_SECONDS = 30 * 60;
export const PROFILE_MAX_AGE_DAYS = 7;
/** Weight of a new real-job sample in the observed throughput. */
const EWMA_ALPHA = 0.3;

export interface CalibrationRequest {
  id: string;
  nonce: string;
  reason: string;
  params: CalibrationParams;
  deadline: string;
}

const toRequest = (r: Record<string, any>): CalibrationRequest => ({
  id: r.id,
  nonce: r.nonce,
  reason: r.reason,
  params: r.params,
  deadline: r.deadline.toISOString(),
});

/** Inventory fingerprint: a new GPU or more RAM means a new calibration. */
export function hardwareSha256(hw: Record<string, any> | null): string {
  const { cpu, ramMb, gpus, os } = hw ?? {};
  return createHash('sha256')
    .update(JSON.stringify({ cpu: cpu ?? null, ramMb: ramMb ?? null, gpus: gpus ?? [], os: os ?? null }))
    .digest('hex');
}

/** Scheduler view of a stored profile; unverified profiles count as uncalibrated. */
export function toPerformanceView(profile: WorkerPerformanceProfile | null, verified: boolean, observed: Observed | null): PerformanceView | null {
  if (!profile || !verified) return null;
  return {
    cpuScore: profile.scores.cpu,
    inference: {
      cpuItemsPerSec: profile.inference.cpu?.itemsPerSec ?? 0,
      gpuItemsPerSec: profile.inference.gpu?.itemsPerSec ?? null,
      ...(profile.inference.cpu ? { cpuStartupMs: profile.inference.cpu.startupMs } : {}),
      gpuStartupMs: profile.inference.gpu?.startupMs ?? null,
    },
    gpu: profile.gpu
      ? { verified: profile.gpu.verified, vramAvailableMb: profile.gpu.vramAvailableMb, nvidia: profile.gpu.nvidia }
      : null,
    network: { latencyMs: profile.network.latencyMs.median, downloadMbps: profile.network.downloadMbps },
    observed: Object.fromEntries(
      Object.entries(observed ?? {}).map(([k, v]) => [k, { itemsPerSec: v.itemsPerSec, samples: v.samples }]),
    ),
  };
}

export class CalibrationService {
  constructor(
    private readonly ctx: AppContext,
    private readonly params: CalibrationParams = DEFAULT_PARAMS,
  ) {}

  /** Called on every heartbeat: the open request, a new one if needed, or null. */
  async forHeartbeat(workerId: string, hb: { state: string; workloadTypes?: string[] | undefined; agentVersion?: string | undefined }) {
    const db = this.ctx.db;
    await db.query(
      `UPDATE worker_calibrations SET status = 'EXPIRED', completed_at = now(), error = 'deadline passed'
        WHERE worker_id = $1 AND status = 'REQUESTED' AND deadline < now()`,
      [workerId],
    );
    const open = (await db.query(`SELECT * FROM worker_calibrations WHERE worker_id = $1 AND status = 'REQUESTED'`, [workerId]))
      .rows[0];
    if (open) return toRequest(open);
    // Only when the owner shares the machine right now and it can execute workloads.
    if (hb.state !== 'available' || !(hb.workloadTypes ?? []).includes('benchmark')) return null;

    const w = (
      await db.query(
        `SELECT w.hardware, w.agent_version, p.hardware_sha256, p.agent_version AS profiled_version, p.calibrated_at, p.verified,
                (SELECT max(requested_at) FROM worker_calibrations c
                  WHERE c.worker_id = w.id AND c.status IN ('FAILED', 'EXPIRED')) AS last_failure
           FROM workers w LEFT JOIN worker_performance p ON p.worker_id = w.id WHERE w.id = $1`,
        [workerId],
      )
    ).rows[0];
    if (!w) return null;
    const reason = this.reason(w, hb.agentVersion ?? w.agent_version);
    if (!reason) return null;
    if (w.last_failure && Date.now() - w.last_failure.getTime() < RETRY_AFTER_SECONDS * 1000) return null;
    return this.request(workerId, reason);
  }

  private reason(w: Record<string, any>, agentVersion: string | null): string | null {
    if (!w.calibrated_at) return 'first-join';
    if (w.hardware_sha256 !== hardwareSha256(w.hardware)) return 'hardware-changed';
    if (agentVersion && w.profiled_version !== agentVersion) return 'agent-updated';
    if (Date.now() - w.calibrated_at.getTime() > PROFILE_MAX_AGE_DAYS * 86_400_000) return 'profile-expired';
    return null;
  }

  /** Opens a calibration (idempotent: returns the open one if any). */
  async request(workerId: string, reason: string): Promise<CalibrationRequest> {
    const { rows } = await this.ctx.db.query(
      `INSERT INTO worker_calibrations (worker_id, nonce, params, reason, deadline)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       ON CONFLICT (worker_id) WHERE status = 'REQUESTED' DO NOTHING RETURNING *`,
      [workerId, randomBytes(16).toString('hex'), this.params, reason, DEADLINE_SECONDS],
    );
    if (rows[0]) {
      await this.ctx.bus.publish('worker.calibration.requested', { workerId, calibrationId: rows[0].id, reason });
      return toRequest(rows[0]);
    }
    const open = await this.ctx.db.query(`SELECT * FROM worker_calibrations WHERE worker_id = $1 AND status = 'REQUESTED'`, [
      workerId,
    ]);
    return toRequest(open.rows[0]);
  }

  private async open(workerId: string, id: string) {
    const c = (await this.ctx.db.query(`SELECT * FROM worker_calibrations WHERE id = $1`, [id])).rows[0];
    if (!c || c.worker_id !== workerId) throw notFound('Calibration');
    if (c.status !== 'REQUESTED' || c.deadline < new Date())
      throw new AppError(409, 'CALIBRATION_NOT_OPEN', 'Calibration is not open');
    return c;
  }

  async download(workerId: string, id: string): Promise<Buffer> {
    const c = await this.open(workerId, id);
    return streamBytes(c.nonce, c.params.network.downloadBytes);
  }

  /** The server times the upload itself and checks the bytes. */
  async upload(workerId: string, id: string, body: Buffer, elapsedMs: number) {
    const c = await this.open(workerId, id);
    const ok = body.length === c.params.network.uploadBytes && sha256Hex(body) === streamSha256(c.nonce, body.length);
    const upload = { bytes: body.length, elapsedMs: Math.max(1, Math.round(elapsedMs)), ok };
    await this.ctx.db.query(
      `UPDATE worker_calibrations SET server_measured = server_measured || jsonb_build_object('upload', $2::jsonb) WHERE id = $1`,
      [id, JSON.stringify(upload)],
    );
    return upload;
  }

  async report(workerId: string, id: string, body: unknown) {
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) throw badRequest('Invalid calibration report', parsed.error.issues.slice(0, 10));
    const res = await withTx(this.ctx.db, async (c) => {
      const cal = (await c.query(`SELECT * FROM worker_calibrations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cal || cal.worker_id !== workerId) throw notFound('Calibration');
      if (cal.status !== 'REQUESTED') throw new AppError(409, 'CALIBRATION_NOT_OPEN', 'Calibration is not open');
      const w = (await c.query(`SELECT hardware FROM workers WHERE id = $1`, [workerId])).rows[0];
      const profile = buildProfile(parsed.data, cal.params, cal.nonce, cal.server_measured as ServerMeasured, w?.hardware ?? null, new Date());
      const hw = hardwareSha256(w?.hardware ?? null);
      await c.query(
        `INSERT INTO worker_performance (worker_id, calibration_id, profile, verified, agent_version, hardware_sha256, calibrated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (worker_id) DO UPDATE SET
           calibration_id = EXCLUDED.calibration_id, profile = EXCLUDED.profile, verified = EXCLUDED.verified,
           agent_version = EXCLUDED.agent_version, calibrated_at = EXCLUDED.calibrated_at, updated_at = now(),
           -- Real-job history stays valid unless the machine itself changed.
           observed = CASE WHEN worker_performance.hardware_sha256 = EXCLUDED.hardware_sha256
                           THEN worker_performance.observed ELSE '{}'::jsonb END,
           hardware_sha256 = EXCLUDED.hardware_sha256`,
        [workerId, id, profile, profile.verified, parsed.data.agentVersion, hw],
      );
      await c.query(
        `UPDATE worker_calibrations SET status = $2, completed_at = now(), report = $3, issues = $4,
                error = CASE WHEN $2 = 'FAILED' THEN 'verification failed' END WHERE id = $1`,
        [id, profile.verified ? 'COMPLETED' : 'FAILED', parsed.data, JSON.stringify(profile.issues)],
      );
      return profile;
    });
    await this.ctx.bus.publish('worker.profiled', {
      workerId,
      calibrationId: id,
      verified: res.verified,
      issues: res.issues,
      scores: res.scores,
    });
    return { status: res.verified ? 'COMPLETED' : 'FAILED', issues: res.issues, profile: res };
  }

  async profile(workerId: string) {
    const exists = await this.ctx.db.query(`SELECT 1 FROM workers WHERE id = $1`, [workerId]);
    if (!exists.rows[0]) throw notFound('Worker');
    const p = (await this.ctx.db.query(`SELECT * FROM worker_performance WHERE worker_id = $1`, [workerId])).rows[0];
    const history = await this.ctx.db.query(
      `SELECT id, reason, status, requested_at, completed_at, issues, error FROM worker_calibrations
        WHERE worker_id = $1 ORDER BY requested_at DESC LIMIT 10`,
      [workerId],
    );
    return {
      workerId,
      profile: p?.profile ?? null,
      summary: p ? summarize(p.profile, p.observed) : null,
      observed: p?.observed ?? {},
      calibratedAt: p?.calibrated_at?.toISOString() ?? null,
      calibrations: history.rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        requestedAt: r.requested_at.toISOString(),
        completedAt: r.completed_at?.toISOString() ?? null,
        issues: r.issues ?? [],
        error: r.error,
      })),
    };
  }

  /**
   * Real-job throughput → EWMA per workload type. The fixed start-up cost measured by the
   * calibration is taken out first, so small and large batches give comparable rates
   * (the scheduler adds it back per attempt).
   */
  async recordObservation(workerId: string, type: string, items: number, seconds: number) {
    if (!(items > 0) || !(seconds > 0)) return;
    const p = (await this.ctx.db.query(`SELECT profile FROM worker_performance WHERE worker_id = $1`, [workerId])).rows[0];
    const startup = (p?.profile?.inference?.cpu?.startupMs ?? 0) / 1000;
    const sample = items / Math.max(seconds * 0.1, seconds - startup);
    await this.ctx.db.query(
      `UPDATE worker_performance SET updated_at = now(), observed = jsonb_set(observed, ARRAY[$2::text],
         jsonb_build_object(
           'itemsPerSec', round((CASE WHEN observed ? $2
                                THEN $4::float * $3::float + (1 - $4::float) * (observed->$2->>'itemsPerSec')::float
                                ELSE $3::float END)::numeric, 2),
           'samples', COALESCE((observed->$2->>'samples')::int, 0) + 1,
           'updatedAt', now()))
        WHERE worker_id = $1`,
      [workerId, type, sample, EWMA_ALPHA],
    );
  }
}
