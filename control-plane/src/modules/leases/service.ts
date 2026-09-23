import type pg from 'pg';
import type { AppContext } from '../../context.js';
import { withTx } from '../../db/pool.js';
import { sha256Hex } from '../../auth/crypto.js';
import { AppError, badRequest, notFound } from '../../errors.js';
import { matchesRequirements, type Hardware, type Requirements } from '../schemas.js';

export const ACTIVE_LEASE = ['offered', 'running'] as const;

interface JobRow {
  id: string;
  status: string;
  priority: number;
  max_retries: number;
  module_name: string;
  module_version: string;
  params: unknown;
  requirements: Requirements;
}
interface TaskRow {
  id: string;
  job_id: string;
  idx: number;
  status: string;
  attempts: number;
  input: unknown;
  created_at: Date;
}
interface LeaseRow {
  id: string;
  task_id: string;
  worker_id: string;
  status: string;
  expires_at: Date;
}

export interface Offer {
  leaseId: string;
  taskId: string;
  jobId: string;
  taskIndex: number;
  module: { name: string; version: string };
  params: unknown;
  input: unknown;
  expiresAt: string;
}

export type Outcome =
  | { kind: 'succeeded'; output: unknown; outputSha256: string }
  | { kind: 'failed'; error: string }
  | { kind: 'preempted'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'expired' }
  | { kind: 'cancelled'; reason: string };

interface Requeue {
  taskId: string;
  priority: number;
  createdAt: Date;
}

const leaseNotActive = () => new AppError(409, 'LEASE_NOT_ACTIVE', 'Lease is no longer active');

export class LeaseService {
  constructor(private readonly ctx: AppContext) {}

  // ---- offers ---------------------------------------------------------------

  /**
   * Leases up to the worker's free slots from the queue.
   * Lock order everywhere: worker -> job -> task -> lease.
   */
  async offerNext(workerId: string, max = Number.MAX_SAFE_INTEGER): Promise<Offer[]> {
    const { queue, config } = this.ctx;
    const offers: Offer[] = [];
    const restore: { taskId: string; score: number }[] = [];
    let popped: { taskId: string; score: number }[] = [];
    const events: { job: JobRow; task: TaskRow; offer: Offer; startedJob: boolean }[] = [];

    try {
      await withTx(this.ctx.db, async (c) => {
        const w = await c.query<{ hardware: Hardware; max_concurrent_tasks: number }>(
          `SELECT hardware, max_concurrent_tasks FROM workers
            WHERE id = $1 AND status = 'active' AND state IN ('available', 'running')
              AND last_seen_at > now() - make_interval(secs => $2)
            FOR UPDATE`,
          [workerId, config.WORKER_OFFLINE_AFTER_SECONDS],
        );
        const worker = w.rows[0];
        if (!worker) return;
        const active = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM leases WHERE worker_id = $1 AND status IN ('offered', 'running')`,
          [workerId],
        );
        const slots = Math.min(max, worker.max_concurrent_tasks - active.rows[0]!.n);
        if (slots <= 0) return;

        // Pop only what can be used so concurrent claimers do not starve each other;
        // a few extra rounds skip past tasks this worker cannot run.
        for (let round = 0; round < 5 && offers.length < slots; round++) {
          const batch = await queue.pop(slots - offers.length);
          if (batch.length === 0) break;
          popped = popped.concat(batch);
          for (const item of batch) {
            if (offers.length >= slots) {
              restore.push(item);
              continue;
            }
            const locked = await lockTaskForOffer(c, item.taskId);
            if (!locked) continue; // stale entry: task gone, not pending or job finished
            if (!matchesRequirements(locked.job.requirements, worker.hardware)) {
              restore.push(item);
              continue;
            }
            const offer = await createLease(c, workerId, locked.job, locked.task, config.LEASE_OFFER_TTL_SECONDS);
            const startedJob = locked.job.status === 'queued';
            if (startedJob) {
              await c.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1`, [locked.job.id]);
            }
            offers.push(offer);
            events.push({ job: locked.job, task: locked.task, offer, startedJob });
          }
        }
      });
    } catch (err) {
      // Nothing was committed; put everything back.
      await queue.restore(popped).catch(() => {});
      throw err;
    }
    await queue.restore(restore);

    for (const e of events) {
      if (e.startedJob) await this.ctx.bus.publish('job.updated', { jobId: e.job.id, status: 'running' });
      await this.ctx.bus.publish('task.updated', {
        jobId: e.job.id,
        taskId: e.task.id,
        status: 'leased',
        leaseId: e.offer.leaseId,
        workerId,
      });
    }
    return offers;
  }

  /** Offers that the worker has not accepted yet (for pull clients / reconnects). */
  async pendingOffers(workerId: string): Promise<Offer[]> {
    const { rows } = await this.ctx.db.query(
      `SELECT l.id AS lease_id, l.expires_at, t.id AS task_id, t.idx, t.input, j.id AS job_id,
              j.module_name, j.module_version, j.params
         FROM leases l JOIN tasks t ON t.id = l.task_id JOIN jobs j ON j.id = t.job_id
        WHERE l.worker_id = $1 AND l.status = 'offered' AND l.expires_at > now()
        ORDER BY l.offered_at`,
      [workerId],
    );
    return rows.map((r) => ({
      leaseId: r.lease_id,
      taskId: r.task_id,
      jobId: r.job_id,
      taskIndex: r.idx,
      module: { name: r.module_name, version: r.module_version },
      params: r.params,
      input: r.input,
      expiresAt: r.expires_at.toISOString(),
    }));
  }

  // ---- worker-driven transitions ---------------------------------------------

  async accept(workerId: string, leaseId: string) {
    const ttl = this.ctx.config.LEASE_RUNNING_TTL_SECONDS;
    const res = await withTx(this.ctx.db, async (c) => {
      const chain = await this.lockOwned(c, workerId, leaseId);
      if (chain.lease.status === 'running') return { chain, changed: false }; // idempotent
      if (chain.lease.status !== 'offered') throw leaseNotActive();
      await c.query(
        `UPDATE leases SET status = 'running', accepted_at = now(), expires_at = now() + make_interval(secs => $2)
          WHERE id = $1`,
        [leaseId, ttl],
      );
      await c.query(`UPDATE tasks SET status = 'running', updated_at = now() WHERE id = $1`, [chain.task.id]);
      await event(c, chain, 'lease.accepted', {});
      return { chain, changed: true };
    });
    if (res.changed) {
      await this.ctx.bus.publish('task.updated', {
        jobId: res.chain.job.id,
        taskId: res.chain.task.id,
        status: 'running',
        leaseId,
        workerId,
      });
    }
    return { leaseId, status: 'running' as const };
  }

  async progress(workerId: string, leaseId: string, p: { progress: number; stage?: string | undefined }) {
    const ttl = this.ctx.config.LEASE_RUNNING_TTL_SECONDS;
    const chain = await withTx(this.ctx.db, async (c) => {
      const chain = await this.lockOwned(c, workerId, leaseId);
      if (chain.lease.status !== 'running') throw leaseNotActive();
      const prev = await c.query<{ stage: string | null }>(`SELECT stage FROM leases WHERE id = $1`, [leaseId]);
      await c.query(
        `UPDATE leases SET progress = $2, stage = COALESCE($3, stage),
                expires_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [leaseId, p.progress, p.stage ?? null, ttl],
      );
      await c.query(`UPDATE tasks SET progress = $2, updated_at = now() WHERE id = $1`, [chain.task.id, p.progress]);
      // Persist stage changes only; raw progress is streamed, not stored.
      if (p.stage && p.stage !== prev.rows[0]?.stage) await event(c, chain, 'task.stage', { stage: p.stage });
      return chain;
    });
    await this.ctx.bus.publish('task.progress', {
      jobId: chain.job.id,
      taskId: chain.task.id,
      leaseId,
      workerId,
      progress: p.progress,
      stage: p.stage,
    });
    return { leaseId, progress: p.progress };
  }

  async reject(workerId: string, leaseId: string, reason: string) {
    return this.finish(workerId, leaseId, { kind: 'rejected', reason }, ['offered']);
  }

  async complete(
    workerId: string,
    leaseId: string,
    r:
      | { status: 'succeeded'; output: unknown; outputSha256: string }
      | { status: 'failed'; error: string }
      | { status: 'preempted'; reason: string },
  ) {
    let outcome: Outcome;
    if (r.status === 'succeeded') {
      const actual = sha256Hex(JSON.stringify(r.output));
      if (actual !== r.outputSha256.toLowerCase()) throw badRequest('outputSha256 does not match output');
      outcome = { kind: 'succeeded', output: r.output, outputSha256: actual };
    } else if (r.status === 'failed') outcome = { kind: 'failed', error: r.error };
    else outcome = { kind: 'preempted', reason: r.reason };
    return this.finish(workerId, leaseId, outcome, ['running']);
  }

  // ---- server-driven transitions ---------------------------------------------

  /** Extends running leases; returns ids the worker must drop. */
  async extendRunning(workerId: string, leaseIds: string[]): Promise<string[]> {
    if (leaseIds.length === 0) return [];
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `UPDATE leases SET expires_at = now() + make_interval(secs => $3)
        WHERE worker_id = $1 AND id = ANY($2::uuid[]) AND status = 'running'
        RETURNING id`,
      [workerId, leaseIds, this.ctx.config.LEASE_RUNNING_TTL_SECONDS],
    );
    const alive = new Set(rows.map((r) => r.id));
    return leaseIds.filter((id) => !alive.has(id));
  }

  /** Expires leases past their deadline. Returns how many were expired. */
  async expireDue(limit = 500): Promise<number> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM leases WHERE status IN ('offered', 'running') AND expires_at < now()
        ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const { id } of rows) {
      if (await this.finishInternal(id, { kind: 'expired' }, ['offered', 'running'], true)) n++;
    }
    return n;
  }

  /** Releases every live lease of a worker (offline or revoked). */
  async releaseWorker(workerId: string, outcome: Extract<Outcome, { kind: 'expired' | 'cancelled' }>) {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM leases WHERE worker_id = $1 AND status IN ('offered', 'running')`,
      [workerId],
    );
    for (const { id } of rows) await this.finishInternal(id, outcome, ['offered', 'running']);
    return rows.map((r) => r.id);
  }

  // ---- internals ------------------------------------------------------------

  private async finish(workerId: string, leaseId: string, outcome: Outcome, from: string[]) {
    const res = await withTx(this.ctx.db, async (c) => {
      const chain = await this.lockOwned(c, workerId, leaseId);
      if (!from.includes(chain.lease.status)) throw leaseNotActive();
      return applyOutcome(c, chain, outcome);
    });
    await this.afterOutcome(res);
    return { leaseId, status: res.leaseStatus, taskStatus: res.taskStatus };
  }

  private async finishInternal(
    leaseId: string,
    outcome: Outcome,
    from: string[],
    onlyIfPastDeadline = false,
  ): Promise<boolean> {
    const res = await withTx(this.ctx.db, async (c) => {
      const chain = await lockChain(c, leaseId);
      if (!chain || !from.includes(chain.lease.status)) return null;
      // Re-check expiry under lock: a heartbeat may have extended it.
      if (onlyIfPastDeadline && chain.lease.expires_at > new Date()) return null;
      return applyOutcome(c, chain, outcome);
    });
    if (!res) return false;
    await this.afterOutcome(res);
    if (outcome.kind === 'cancelled') {
      await this.ctx.bus.sendToWorker(res.workerId, { type: 'lease.cancel', leaseId, reason: outcome.reason });
    }
    return true;
  }

  private async afterOutcome(res: OutcomeResult) {
    if (res.requeue) await this.ctx.queue.enqueue([res.requeue]);
    await this.ctx.bus.publish('task.updated', {
      jobId: res.jobId,
      taskId: res.taskId,
      leaseId: res.leaseId,
      workerId: res.workerId,
      status: res.taskStatus,
      leaseStatus: res.leaseStatus,
    });
    if (res.job) await this.ctx.bus.publish('job.updated', res.job);
  }

  private async lockOwned(c: pg.PoolClient, workerId: string, leaseId: string): Promise<Chain> {
    const chain = await lockChain(c, leaseId);
    // Same error for "missing" and "someone else's": do not leak lease ids.
    if (!chain || chain.lease.worker_id !== workerId) throw notFound('Lease');
    return chain;
  }
}

interface Chain {
  job: JobRow;
  task: TaskRow;
  lease: LeaseRow;
}

async function lockChain(c: pg.PoolClient, leaseId: string): Promise<Chain | null> {
  const ref = await c.query<{ job_id: string; task_id: string }>(
    `SELECT t.job_id, t.id AS task_id FROM leases l JOIN tasks t ON t.id = l.task_id WHERE l.id = $1`,
    [leaseId],
  );
  const r = ref.rows[0];
  if (!r) return null;
  const job = (await c.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [r.job_id])).rows[0]!;
  const task = (await c.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [r.task_id])).rows[0]!;
  const lease = (await c.query<LeaseRow>(`SELECT * FROM leases WHERE id = $1 FOR UPDATE`, [leaseId])).rows[0]!;
  return { job, task, lease };
}

async function lockTaskForOffer(c: pg.PoolClient, taskId: string) {
  const ref = await c.query<{ job_id: string }>(`SELECT job_id FROM tasks WHERE id = $1`, [taskId]);
  if (!ref.rows[0]) return null;
  const job = (
    await c.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 AND status IN ('queued', 'running') FOR UPDATE`, [
      ref.rows[0].job_id,
    ])
  ).rows[0];
  if (!job) return null;
  const task = (await c.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 AND status = 'pending' FOR UPDATE`, [taskId]))
    .rows[0];
  if (!task) return null;
  return { job, task };
}

async function createLease(c: pg.PoolClient, workerId: string, job: JobRow, task: TaskRow, ttl: number): Promise<Offer> {
  const l = await c.query<{ id: string; expires_at: Date }>(
    `INSERT INTO leases (task_id, worker_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id, expires_at`,
    [task.id, workerId, ttl],
  );
  const lease = l.rows[0]!;
  await c.query(`UPDATE tasks SET status = 'leased', updated_at = now() WHERE id = $1`, [task.id]);
  await c.query(
    `INSERT INTO task_events (job_id, task_id, lease_id, worker_id, type) VALUES ($1, $2, $3, $4, 'lease.offered')`,
    [job.id, task.id, lease.id, workerId],
  );
  return {
    leaseId: lease.id,
    taskId: task.id,
    jobId: job.id,
    taskIndex: task.idx,
    module: { name: job.module_name, version: job.module_version },
    params: job.params,
    input: task.input,
    expiresAt: lease.expires_at.toISOString(),
  };
}

async function event(c: pg.PoolClient, chain: Chain, type: string, payload: Record<string, unknown>) {
  await c.query(
    `INSERT INTO task_events (job_id, task_id, lease_id, worker_id, type, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
    [chain.job.id, chain.task.id, chain.lease.id, chain.lease.worker_id, type, payload],
  );
}

interface OutcomeResult {
  jobId: string;
  taskId: string;
  leaseId: string;
  workerId: string;
  leaseStatus: string;
  taskStatus: string;
  requeue?: Requeue;
  job?: Record<string, unknown>;
}

async function applyOutcome(c: pg.PoolClient, chain: Chain, o: Outcome): Promise<OutcomeResult> {
  const { job, task, lease } = chain;
  let taskStatus: string;
  let attempts = task.attempts;
  let lastError: string | null = null;

  switch (o.kind) {
    case 'succeeded':
      taskStatus = 'succeeded';
      break;
    case 'failed':
    case 'expired':
      attempts += 1;
      lastError = o.kind === 'failed' ? o.error : 'lease expired';
      taskStatus = attempts > job.max_retries ? 'failed' : 'pending';
      break;
    default:
      // preempted / rejected / cancelled: not the task's fault.
      taskStatus = 'pending';
      lastError = o.reason;
  }
  // A cancelled job never goes back to the queue.
  if (taskStatus === 'pending' && job.status === 'cancelled') taskStatus = 'cancelled';

  const leaseError = o.kind === 'succeeded' || o.kind === 'expired' ? null : 'error' in o ? o.error : o.reason;
  await c.query(`UPDATE leases SET status = $2, error = $3, finished_at = now() WHERE id = $1`, [
    lease.id,
    o.kind,
    leaseError,
  ]);

  const terminal = ['succeeded', 'failed', 'cancelled'].includes(taskStatus);
  await c.query(
    `UPDATE tasks SET status = $2, attempts = $3, last_error = COALESCE($4, last_error),
            output = $5, output_sha256 = $6,
            progress = CASE WHEN $2 = 'succeeded' THEN 1 WHEN $2 = 'pending' THEN 0 ELSE progress END,
            finished_at = CASE WHEN $7 THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1`,
    [
      task.id,
      taskStatus,
      attempts,
      lastError,
      o.kind === 'succeeded' ? JSON.stringify(o.output) : null,
      o.kind === 'succeeded' ? o.outputSha256 : null,
      terminal,
    ],
  );
  await event(c, chain, `lease.${o.kind}`, lastError ? { error: lastError, attempts } : { attempts });

  const result: OutcomeResult = {
    jobId: job.id,
    taskId: task.id,
    leaseId: lease.id,
    workerId: lease.worker_id,
    leaseStatus: o.kind,
    taskStatus,
  };
  if (taskStatus === 'pending') result.requeue = { taskId: task.id, priority: job.priority, createdAt: task.created_at };
  if (terminal) result.job = await refreshJob(c, job.id);
  return result;
}

/** Recomputes counters and terminal status. Caller must hold the job lock. */
export async function refreshJob(c: pg.PoolClient, jobId: string) {
  const { rows } = await c.query(
    `WITH c AS (
       SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS s,
              count(*) FILTER (WHERE status = 'failed')::int    AS f,
              count(*) FILTER (WHERE status = 'cancelled')::int AS x,
              count(*) FILTER (WHERE status IN ('pending', 'leased', 'running'))::int AS live
         FROM tasks WHERE job_id = $1)
     UPDATE jobs j SET
       succeeded_tasks = c.s, failed_tasks = c.f, cancelled_tasks = c.x,
       status = CASE WHEN j.status IN ('completed', 'failed', 'cancelled') THEN j.status
                     WHEN c.live = 0 AND c.f > 0 THEN 'failed'
                     WHEN c.live = 0 THEN 'completed'
                     ELSE j.status END,
       finished_at = CASE WHEN j.finished_at IS NULL AND c.live = 0 THEN now() ELSE j.finished_at END
     FROM c WHERE j.id = $1
     RETURNING j.id, j.status, j.succeeded_tasks, j.failed_tasks, j.cancelled_tasks, j.total_tasks`,
    [jobId],
  );
  const j = rows[0];
  return {
    jobId: j.id,
    status: j.status,
    succeededTasks: j.succeeded_tasks,
    failedTasks: j.failed_tasks,
    cancelledTasks: j.cancelled_tasks,
    totalTasks: j.total_tasks,
  };
}

