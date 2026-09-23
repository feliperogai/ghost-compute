import type { AppContext } from '../../context.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../audit.js';
import { generateSecret, hashSecret, hasPrefix, safeEqual, signWorkerToken } from '../../auth/crypto.js';
import { AppError, conflict, notFound, unauthorized } from '../../errors.js';
import type { Hardware } from '../schemas.js';
import { JobLifecycle, type AssignmentOffer } from '../../jobs/lifecycle.js';
import type { Capacity } from '../../scheduler/types.js';
import { CalibrationService } from '../../performance/service.js';

export type ReportedState = 'waiting' | 'available' | 'running' | 'paused' | 'stopped';

export interface HeartbeatInput {
  state: ReportedState;
  usage: Record<string, number | boolean | undefined>;
  activeAssignmentIds: string[];
  capacity?: Capacity | undefined;
  workloadTypes?: string[] | undefined;
  agentVersion?: string | undefined;
}

const WORKER_COLUMNS = `id, name, device_id, owner_user_id, status, state, max_concurrent_tasks, hardware, last_usage,
  capacity, workload_types, agent_version, last_seen_at, created_at, revoked_at, revoked_reason`;

export function toWorkerDto(r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    deviceId: r.device_id ?? null,
    ownerUserId: r.owner_user_id,
    status: r.status,
    state: r.state,
    maxConcurrentTasks: r.max_concurrent_tasks,
    hardware: r.hardware,
    lastUsage: r.last_usage,
    capacity: r.capacity ?? null,
    workloadTypes: r.workload_types ?? [],
    agentVersion: r.agent_version,
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedReason: r.revoked_reason,
    activeAssignments: r.active_assignments ?? undefined,
  };
}

export class WorkerService {
  private readonly jobs: JobLifecycle;
  private readonly calibration: CalibrationService;

  constructor(private readonly ctx: AppContext) {
    this.jobs = new JobLifecycle(ctx);
    this.calibration = new CalibrationService(ctx);
  }

  async register(input: {
    enrollmentToken: string;
    name: string;
    hardware: Hardware;
    maxConcurrentTasks: number;
    agentVersion?: string | undefined;
    deviceId?: string | undefined;
  }) {
    if (!hasPrefix(input.enrollmentToken, 'enroll')) throw unauthorized('Invalid enrollment token');
    const secret = generateSecret('worker');
    const worker = await withTx(this.ctx.db, async (c) => {
      const t = await c.query<{ id: string; created_by: string }>(
        `SELECT id, created_by FROM enrollment_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashSecret(input.enrollmentToken)],
      );
      const token = t.rows[0];
      if (!token) throw unauthorized('Invalid enrollment token');
      const w = await c.query(
        `INSERT INTO workers (name, owner_user_id, secret_hash, max_concurrent_tasks, hardware, agent_version, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${WORKER_COLUMNS}`,
        [
          input.name,
          token.created_by,
          hashSecret(secret),
          input.maxConcurrentTasks,
          input.hardware,
          input.agentVersion ?? null,
          input.deviceId ?? null,
        ],
      );
      const worker = w.rows[0];
      await c.query(`UPDATE enrollment_tokens SET used_at = now(), used_by_worker_id = $2 WHERE id = $1`, [
        token.id,
        worker.id,
      ]);
      await audit(c, {
        actorType: 'worker',
        actorId: worker.id,
        action: 'worker.register',
        targetType: 'worker',
        targetId: worker.id,
        details: { name: input.name, enrollmentTokenId: token.id, deviceId: input.deviceId ?? null },
      });
      return worker;
    });
    await this.ctx.bus.publish('worker.registered', { worker: toWorkerDto(worker) });
    return { workerId: worker.id as string, workerSecret: secret };
  }

  async authenticate(workerId: string, secret: string) {
    const { rows } = await this.ctx.db.query<{ secret_hash: Buffer; status: string }>(
      `SELECT secret_hash, status FROM workers WHERE id = $1`,
      [workerId],
    );
    const w = rows[0];
    // Constant-ish path: hash even when the worker does not exist.
    const ok = safeEqual(hashSecret(secret), w?.secret_hash ?? Buffer.alloc(32));
    if (!w || !ok) throw unauthorized('Invalid worker credentials');
    if (w.status !== 'active') throw new AppError(403, 'WORKER_REVOKED', 'Worker has been revoked');
    const ttl = this.ctx.config.WORKER_TOKEN_TTL_SECONDS;
    return {
      accessToken: signWorkerToken(workerId, this.ctx.config.WORKER_TOKEN_SECRET, ttl),
      tokenType: 'Bearer' as const,
      expiresIn: ttl,
    };
  }

  async revoke(workerId: string, reason: string, actorId: string) {
    const worker = await withTx(this.ctx.db, async (c) => {
      const cur = await c.query(`SELECT status FROM workers WHERE id = $1 FOR UPDATE`, [workerId]);
      if (!cur.rows[0]) throw notFound('Worker');
      if (cur.rows[0].status === 'revoked') throw conflict('Worker already revoked');
      const w = await c.query(
        `UPDATE workers SET status = 'revoked', state = 'offline', revoked_at = now(), revoked_reason = $2
          WHERE id = $1 RETURNING ${WORKER_COLUMNS}`,
        [workerId, reason],
      );
      await audit(c, {
        actorType: 'user',
        actorId,
        action: 'worker.revoke',
        targetType: 'worker',
        targetId: workerId,
        details: { reason },
      });
      return w.rows[0];
    });
    // Its running jobs are re-routed; results it may still send are refused (worker no longer authenticates).
    const released = await this.jobs.releaseWorker(workerId, 'worker revoked');
    await this.ctx.bus.sendToWorker(workerId, { type: 'worker.revoked', reason });
    await this.ctx.bus.publish('worker.revoked', { workerId, reason, releasedAssignments: released });
    return toWorkerDto(worker);
  }

  async list(f: { status?: string | undefined; state?: string | undefined; limit: number; offset: number }) {
    const { rows } = await this.ctx.db.query(
      `SELECT ${WORKER_COLUMNS},
              (SELECT count(*)::int FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('assigned', 'running'))
                AS active_assignments,
              count(*) OVER ()::int AS total
         FROM workers w
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR state = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [f.status ?? null, f.state ?? null, f.limit, f.offset],
    );
    return { items: rows.map(toWorkerDto), total: rows[0]?.total ?? 0 };
  }

  async get(workerId: string) {
    const { rows } = await this.ctx.db.query(`SELECT ${WORKER_COLUMNS} FROM workers WHERE id = $1`, [workerId]);
    if (!rows[0]) throw notFound('Worker');
    const active = await this.ctx.db.query(
      `SELECT a.id, a.job_id, a.status, a.attempt, a.assigned_at, a.started_at, a.last_seen_at, j.type, j.name, j.progress, j.stage
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.worker_id = $1 AND a.status IN ('assigned', 'running') ORDER BY a.assigned_at`,
      [workerId],
    );
    return {
      ...toWorkerDto(rows[0]),
      online: rows[0].state !== 'offline',
      assignments: active.rows.map((a) => ({
        id: a.id,
        jobId: a.job_id,
        jobName: a.name,
        type: a.type,
        status: a.status,
        attempt: a.attempt,
        progress: a.progress,
        stage: a.stage,
        assignedAt: a.assigned_at.toISOString(),
        startedAt: a.started_at?.toISOString() ?? null,
        lastSeenAt: a.last_seen_at?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Contribution summary shown in the desktop app.
   * Credits are internal and non-monetary: 1 credit = 1 minute of successfully completed task time.
   */
  async stats(workerId: string, recentLimit: number) {
    const totals = await this.ctx.db.query<{
      completed: number;
      failed: number;
      interrupted: number;
      active: number;
      seconds: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status IN ('failed', 'timeout'))::int AS failed,
              count(*) FILTER (WHERE status IN ('lost', 'expired'))::int AS interrupted,
              count(*) FILTER (WHERE status IN ('assigned', 'running'))::int AS active,
              COALESCE(sum(EXTRACT(EPOCH FROM finished_at - started_at))
                         FILTER (WHERE status = 'completed' AND started_at IS NOT NULL), 0)::float AS seconds
         FROM job_assignments WHERE worker_id = $1`,
      [workerId],
    );
    const recent = await this.ctx.db.query(
      `SELECT a.id, a.status, a.attempt, a.assigned_at, a.started_at, a.finished_at,
              j.id AS job_id, j.name, j.type, j.progress, j.stage
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.worker_id = $1 AND a.status <> 'rejected'
        ORDER BY a.assigned_at DESC LIMIT $2`,
      [workerId, recentLimit],
    );
    const t = totals.rows[0]!;
    return {
      tasks: { succeeded: t.completed, failed: t.failed, preempted: t.interrupted, active: t.active },
      computeSeconds: Math.round(t.seconds),
      credits: Math.round((t.seconds / 60) * 100) / 100,
      recent: recent.rows.map((r) => ({
        assignmentId: r.id,
        jobId: r.job_id,
        jobName: r.name ?? r.type,
        type: r.type,
        attempt: r.attempt,
        status: r.status,
        progress: r.progress,
        stage: r.stage,
        assignedAt: r.assigned_at.toISOString(),
        startedAt: r.started_at?.toISOString() ?? null,
        finishedAt: r.finished_at?.toISOString() ?? null,
      })),
    };
  }

  async heartbeat(workerId: string, hb: HeartbeatInput) {
    const { rows } = await this.ctx.db.query<{ prev_state: string; state: string }>(
      `UPDATE workers w SET state = $2, last_usage = $3, last_seen_at = now(),
              agent_version = COALESCE($4, w.agent_version),
              capacity = COALESCE($5, w.capacity),
              workload_types = COALESCE($6, w.workload_types)
         FROM (SELECT state AS prev_state FROM workers WHERE id = $1 FOR UPDATE) p
        WHERE w.id = $1 AND w.status = 'active'
        RETURNING p.prev_state, w.state`,
      [workerId, hb.state, hb.usage, hb.agentVersion ?? null, hb.capacity ?? null, hb.workloadTypes ?? null],
    );
    const row = rows[0];
    if (!row) throw new AppError(403, 'WORKER_REVOKED', 'Worker has been revoked');

    const cancelAssignmentIds = await this.jobs.touch(workerId, hb.activeAssignmentIds);

    if (row.prev_state !== row.state) {
      const type = row.prev_state === 'offline' ? 'worker.online' : 'worker.state';
      await this.ctx.bus.publish(type, { workerId, from: row.prev_state, to: row.state });
    }
    await this.ctx.bus.publish('worker.heartbeat', { workerId, state: hb.state, usage: hb.usage });

    const assignments: AssignmentOffer[] = await this.jobs.pendingFor(workerId);
    // Benchmarks on join (and after hardware/agent changes); the agent runs them when idle.
    const calibration = await this.calibration.forHeartbeat(workerId, hb);
    return {
      serverTime: new Date().toISOString(),
      heartbeatIntervalSeconds: this.ctx.config.HEARTBEAT_INTERVAL_SECONDS,
      cancelAssignmentIds,
      assignments,
      ...(calibration ? { calibration } : {}),
    };
  }

  /** Marks silent workers offline; their jobs are re-routed. */
  async detectOffline(): Promise<string[]> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `UPDATE workers SET state = 'offline'
        WHERE status = 'active' AND state <> 'offline'
          AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $1))
        RETURNING id`,
      [this.ctx.config.WORKER_OFFLINE_AFTER_SECONDS],
    );
    for (const { id } of rows) {
      const released = await this.jobs.releaseWorker(id, 'worker went offline');
      await this.ctx.bus.publish('worker.offline', { workerId: id, releasedAssignments: released });
    }
    return rows.map((r) => r.id);
  }
}
