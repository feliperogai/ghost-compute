// Every job/assignment state transition, each in one transaction.
// Lock order everywhere: worker → job → assignment.
import type pg from 'pg';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { sha256Hex } from '../auth/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { countsAsFailure, defaultRetryPolicy, type AttemptOutcome, type RetryPolicy } from '../scheduler/retry.js';
import type { JobStatus, Placement, Resources } from '../scheduler/types.js';
import { refreshGroupForJob } from '../inference/groups.js';
import { validateCheckpoint } from '../inference/schemas.js';
import { CalibrationService } from '../performance/service.js';
import { settleJob } from '../credits/service.js';
import { verdict } from './verification.js';
import { owedSql } from '../credits/owed.js';
import { maxAttemptCost, normalizeOffer, priceRate } from '../market/offer.js';

export interface AssignmentOffer {
  assignmentId: string;
  jobId: string;
  /** Display name for the owner's desktop app (optional). */
  name: string | null;
  attempt: number;
  type: string;
  input: unknown;
  resources: Resources;
  timeoutSeconds: number;
  acceptBy: string;
  /** Partial results of an earlier attempt (resumable workloads). */
  checkpoint?: unknown;
}

/** Called after a job reaches a terminal state (groups aggregate their batches). */
export type TerminalHook = (jobId: string) => Promise<void>;
const TERMINAL: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];

interface JobRow {
  id: string;
  name: string | null;
  status: JobStatus;
  type: string;
  priority: number;
  input: unknown;
  resources: Resources;
  timeout_seconds: number;
  max_attempts: number;
  failures: number;
  created_at: Date;
  group_id: string | null;
  checkpoint: unknown;
  retry_on_timeout: boolean;
  /** Millicredits (bigint → string); null for jobs created before budgets. */
  budget: string | null;
  verification: 'none' | 'replicate';
}

interface AssignmentRow {
  id: string;
  job_id: string;
  worker_id: string;
  attempt: number;
  status: string;
  accept_deadline: Date;
  started_at: Date | null;
  last_seen_at: Date | null;
}

const ACTIVE = ['assigned', 'running'];
const notActive = () => new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'Assignment is no longer active');

interface After {
  jobId: string;
  status: JobStatus;
  workerId: string | null;
  assignmentId?: string;
  requeue?: { priority: number; createdAt: Date };
  dequeue?: boolean;
  /** Tell the worker to stop this assignment. */
  cancelOnWorker?: { workerId: string; assignmentId: string; reason: string };
  extra?: Record<string, unknown>;
}

export class JobLifecycle {
  private readonly onTerminal: TerminalHook;

  constructor(
    private readonly ctx: AppContext,
    private readonly policy: RetryPolicy = defaultRetryPolicy,
    onTerminal?: TerminalHook,
  ) {
    this.onTerminal = onTerminal ?? ((jobId) => refreshGroupForJob(ctx, jobId));
  }

  // ---- scheduler ---------------------------------------------------------------

  /** Persists a placement. Returns null if the job or worker changed meanwhile. */
  async assign(p: Placement, strategy: string, reserved: Resources): Promise<AssignmentOffer | null> {
    const acceptSecs = this.ctx.config.ASSIGNMENT_ACCEPT_SECONDS;
    const offer = await withTx(this.ctx.db, async (c) => {
      // Last line of defence against over-commit (e.g. two schedulers during a leader hand-over).
      // Lock the worker row FIRST, in its own statement: under READ COMMITTED the next
      // statement then takes a fresh snapshot that includes assignments committed by
      // whoever held the lock before us. (Aggregating in the same statement as FOR UPDATE
      // would use the pre-wait snapshot and miss them.)
      const locked = await c.query(
        `SELECT 1 FROM workers WHERE id = $1 AND status = 'active' AND state IN ('available', 'running') FOR UPDATE`,
        [p.workerId],
      );
      if (!locked.rows[0]) return null;
      const w = await c.query<{ ok: boolean }>(
        `SELECT w.max_concurrent_tasks > r.n
                AND COALESCE((w.capacity->>'cpuCores')::float, 0) >= r.cpu + $2
                AND COALESCE((w.capacity->>'ramMb')::int, 0) >= r.ram + $3
                AND COALESCE((w.capacity->>'vramMb')::int, 0) >= r.vram + $4
                AND NOT ($5 AND r.gpu) AS ok
           FROM workers w,
                LATERAL (SELECT count(*) AS n,
                                COALESCE(sum((a.reserved->>'cpuCores')::float), 0) AS cpu,
                                COALESCE(sum((a.reserved->>'ramMb')::int), 0) AS ram,
                                COALESCE(sum((a.reserved->>'vramMb')::int), 0) AS vram,
                                COALESCE(bool_or((a.reserved->>'gpu')::boolean), false) AS gpu
                           FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('assigned', 'running')) r
          WHERE w.id = $1`,
        [p.workerId, reserved.cpuCores, reserved.ramMb, reserved.vramMb, reserved.gpu],
      );
      if (!w.rows[0]?.ok) return null;
      const job = (await c.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 AND status = 'QUEUED' FOR UPDATE`, [p.jobId]))
        .rows[0];
      if (!job) return null;
      // The provider's price now (not the scheduler's snapshot) is what this attempt costs,
      // and it must still fit the customer's budget.
      const o = await c.query(`SELECT listed, price, availability, limits FROM worker_offers WHERE worker_id = $1`, [p.workerId]);
      const offer = normalizeOffer(o.rows[0] ?? null);
      if (!offer.listed) return null;
      const rate = priceRate(offer.price, reserved);
      if (job.budget !== null) {
        const spent = await c.query<{ s: string }>(`SELECT ${owedSql('j')}::text AS s FROM jobs j WHERE j.id = $1`, [job.id]);
        if (maxAttemptCost(rate, job.timeout_seconds) > Number(job.budget) - Number(spent.rows[0]!.s)) return null;
      }
      const a = await c.query<{ id: string; attempt: number; accept_deadline: Date }>(
        `INSERT INTO job_assignments (job_id, worker_id, attempt, strategy, score, score_detail, reserved, accept_deadline, price_rate)
         VALUES ($1, $2, (SELECT count(*) + 1 FROM job_assignments WHERE job_id = $1), $3, $4, $5, $6,
                 now() + make_interval(secs => $7), $8)
         RETURNING id, attempt, accept_deadline`,
        [job.id, p.workerId, strategy, p.score.total, p.score, reserved, acceptSecs, rate],
      );
      const row = a.rows[0]!;
      await c.query(
        `UPDATE jobs SET status = 'ASSIGNED', worker_id = $2, assigned_at = now(), pending_reason = NULL,
                         updated_at = now() WHERE id = $1`,
        [job.id, p.workerId],
      );
      // Every decision is recorded with its reason (strategies without one get a plain note).
      const summary =
        p.explanation?.summary ?? `Worker ${p.workerId.slice(0, 8)} escolhido pela estratégia ${strategy} (score ${p.score.total}).`;
      await c.query(
        `INSERT INTO scheduler_decisions (job_id, assignment_id, worker_id, strategy, score, summary, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [job.id, row.id, p.workerId, strategy, p.score.total, summary, p.explanation ?? { score: p.score }],
      );
      await event(c, job.id, row.id, p.workerId, 'job.assigned', {
        attempt: row.attempt,
        score: { total: p.score.total, components: p.score.components },
        strategy,
        reason: summary,
      });
      return {
        assignmentId: row.id,
        jobId: job.id,
        name: job.name,
        attempt: row.attempt,
        type: job.type,
        input: job.input,
        resources: job.resources,
        timeoutSeconds: job.timeout_seconds,
        acceptBy: row.accept_deadline.toISOString(),
        ...(job.checkpoint != null ? { checkpoint: job.checkpoint } : {}),
      } satisfies AssignmentOffer;
    });
    if (offer) {
      await this.after({ jobId: offer.jobId, status: 'ASSIGNED', workerId: p.workerId, assignmentId: offer.assignmentId, dequeue: true });
      await this.ctx.bus.sendToWorker(p.workerId, { type: 'job.assigned', assignment: { ...offer } });
    }
    return offer;
  }

  async setPendingReason(jobId: string, reason: string | null) {
    await this.ctx.db.query(
      `UPDATE jobs SET pending_reason = $2 WHERE id = $1 AND status = 'QUEUED' AND pending_reason IS DISTINCT FROM $2`,
      [jobId, reason],
    );
  }

  // ---- worker-driven ------------------------------------------------------------

  async pendingFor(workerId: string): Promise<AssignmentOffer[]> {
    const { rows } = await this.ctx.db.query(
      `SELECT a.id, a.attempt, a.accept_deadline, j.id AS job_id, j.name, j.type, j.input, j.resources, j.timeout_seconds,
              j.checkpoint
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.worker_id = $1 AND a.status = 'assigned' AND a.accept_deadline > now()
        ORDER BY a.assigned_at`,
      [workerId],
    );
    return rows.map((r) => ({
      assignmentId: r.id,
      jobId: r.job_id,
      name: r.name,
      attempt: r.attempt,
      type: r.type,
      input: r.input,
      resources: r.resources,
      timeoutSeconds: r.timeout_seconds,
      acceptBy: r.accept_deadline.toISOString(),
      ...(r.checkpoint != null ? { checkpoint: r.checkpoint } : {}),
    }));
  }

  async accept(workerId: string, assignmentId: string) {
    const res = await withTx(this.ctx.db, async (c) => {
      const { job, a } = await this.lockOwned(c, workerId, assignmentId);
      if (a.status === 'running') return null; // idempotent
      if (a.status !== 'assigned') throw notActive();
      await c.query(`UPDATE job_assignments SET status = 'running', started_at = now(), last_seen_at = now() WHERE id = $1`, [a.id]);
      await c.query(
        `UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
        [job.id],
      );
      await event(c, job.id, a.id, workerId, 'job.started', { attempt: a.attempt });
      return { jobId: job.id, status: 'RUNNING' as const, workerId, assignmentId: a.id };
    });
    if (res) await this.after(res);
    return { assignmentId, status: 'running' };
  }

  async progress(
    workerId: string,
    assignmentId: string,
    progress: number,
    stage?: string,
    checkpoint?: unknown,
  ) {
    const jobId = await withTx(this.ctx.db, async (c) => {
      const { job, a } = await this.lockOwned(c, workerId, assignmentId);
      if (a.status !== 'running') throw notActive();
      if (checkpoint !== undefined) {
        // Only resumable jobs keep checkpoints, and only ones that fit the job's own input.
        if (!job.group_id) throw badRequest('This job does not accept checkpoints');
        const problem = validateCheckpoint(job.input, checkpoint);
        if (problem) throw badRequest(`Invalid checkpoint: ${problem}`);
        // Verified jobs keep none: a replica must never start from another computer's work.
        if (job.verification !== 'replicate')
          await c.query(`UPDATE jobs SET checkpoint = $2 WHERE id = $1`, [job.id, JSON.stringify(checkpoint)]);
      }
      await c.query(`UPDATE job_assignments SET last_seen_at = now() WHERE id = $1`, [a.id]);
      const prev = await c.query<{ stage: string | null }>(`SELECT stage FROM jobs WHERE id = $1`, [job.id]);
      await c.query(`UPDATE jobs SET progress = $2, stage = COALESCE($3, stage), updated_at = now() WHERE id = $1`, [
        job.id,
        progress,
        stage ?? null,
      ]);
      if (stage && stage !== prev.rows[0]?.stage) await event(c, job.id, a.id, workerId, 'job.stage', { stage });
      return job.id;
    });
    await this.ctx.bus.publish('job.progress', { jobId, assignmentId, workerId, progress, stage });
    return { assignmentId, progress };
  }

  async complete(workerId: string, assignmentId: string, output: unknown, outputSha256: string) {
    const actual = sha256Hex(JSON.stringify(output));
    if (actual !== outputSha256.toLowerCase()) throw badRequest('outputSha256 does not match output');
    const res = await withTx(this.ctx.db, async (c): Promise<After & { observation: ReturnType<typeof observe> }> => {
      const { job, a } = await this.lockOwned(c, workerId, assignmentId);
      if (a.status !== 'running') throw notActive();
      // Every attempt keeps its own result: replicas are compared before the job gets one.
      await c.query(
        `UPDATE job_assignments SET status = 'completed', finished_at = now(), output = $2, output_sha256 = $3 WHERE id = $1`,
        [a.id, JSON.stringify(output), actual],
      );
      const observation = observe(job.type, output, a.started_at);
      if (job.verification === 'replicate') {
        const r = await this.verifyReplicas(c, job, a, actual);
        return { ...r, observation };
      }
      await this.finishCompleted(c, job, output, actual);
      await event(c, job.id, a.id, workerId, 'job.completed', { attempt: a.attempt, outputSha256: actual });
      // Credits move in the same transaction as the state change: all or nothing.
      await settleJob(c, job.id);
      return { jobId: job.id, status: 'COMPLETED', workerId, assignmentId: a.id, observation };
    });
    const { observation, ...after } = res;
    await this.after(after);
    // Real throughput feeds the worker's profile (the scheduler prefers it over benchmarks).
    if (observation)
      await new CalibrationService(this.ctx)
        .recordObservation(workerId, observation.type, observation.items, observation.seconds)
        .catch(() => {});
    return { assignmentId, jobStatus: res.status };
  }

  private async finishCompleted(c: pg.PoolClient, job: JobRow, output: unknown, sha: string) {
    await c.query(
      `UPDATE jobs SET status = 'COMPLETED', output = $2, output_sha256 = $3, error = NULL, progress = 1,
                       finished_at = now(), updated_at = now() WHERE id = $1`,
      [job.id, JSON.stringify(output), sha],
    );
  }

  /**
   * A replica of a verified job finished. Two results from different owners that agree
   * complete the job; otherwise another replica is queued (other owners only), up to
   * MAX_REPLICAS, after which the job fails with RESULT_MISMATCH and nobody is paid.
   */
  private async verifyReplicas(c: pg.PoolClient, job: JobRow, a: AssignmentRow, sha: string): Promise<After> {
    const { rows } = await c.query<{ id: string; owner_user_id: string | null; output: unknown }>(
      `SELECT x.id, w.owner_user_id, x.output FROM job_assignments x JOIN workers w ON w.id = x.worker_id
        WHERE x.job_id = $1 AND x.status = 'completed' ORDER BY x.attempt`,
      [job.id],
    );
    const v = verdict(
      job.type,
      rows.map((r) => ({ assignmentId: r.id, ownerId: r.owner_user_id, output: r.output })),
    );
    const base = { jobId: job.id, workerId: a.worker_id, assignmentId: a.id };
    if (v.kind === 'agreed') {
      await c.query(`UPDATE job_assignments SET verdict = 'agreed' WHERE id = ANY($1::uuid[])`, [v.agreed]);
      if (v.disagreed.length)
        await c.query(`UPDATE job_assignments SET verdict = 'disagreed' WHERE id = ANY($1::uuid[])`, [v.disagreed]);
      const win = rows.find((r) => r.id === v.winner)!;
      const winSha = sha256Hex(JSON.stringify(win.output));
      await this.finishCompleted(c, job, win.output, winSha);
      await event(c, job.id, a.id, a.worker_id, 'job.completed', {
        attempt: a.attempt,
        outputSha256: winSha,
        verification: { agreed: v.agreed, disagreed: v.disagreed },
      });
      await settleJob(c, job.id);
      return { ...base, status: 'COMPLETED' };
    }
    if (v.kind === 'mismatch') {
      await c.query(`UPDATE job_assignments SET verdict = 'disagreed' WHERE id = ANY($1::uuid[])`, [v.disagreed]);
      const err = { code: 'RESULT_MISMATCH', message: `${rows.length} replicas from different computers disagreed` };
      await c.query(`UPDATE jobs SET status = 'FAILED', error = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [
        job.id,
        err,
      ]);
      await event(c, job.id, a.id, a.worker_id, 'job.failed', err);
      await settleJob(c, job.id);
      return { ...base, status: 'FAILED' };
    }
    // Needs another opinion: back to the queue, excluding the owners already heard.
    await c.query(
      `UPDATE jobs SET status = 'QUEUED', worker_id = NULL, assigned_at = NULL, progress = 0, stage = 'verifying',
                       checkpoint = NULL, updated_at = now() WHERE id = $1`,
      [job.id],
    );
    await event(c, job.id, a.id, a.worker_id, 'job.replica', { replicas: rows.length, outputSha256: sha });
    return { ...base, status: 'QUEUED', requeue: { priority: job.priority, createdAt: job.created_at }, extra: { replica: rows.length } };
  }

  async reject(workerId: string, assignmentId: string, reason: string) {
    return this.endOwned(workerId, assignmentId, { kind: 'rejected' }, reason, ['assigned']);
  }

  async fail(workerId: string, assignmentId: string, error: string, retryable: boolean) {
    return this.endOwned(workerId, assignmentId, { kind: 'failed', retryable }, error, ['running']);
  }

  /** Heartbeat: refreshes liveness; returns ids the worker must drop. */
  async touch(workerId: string, assignmentIds: string[]): Promise<string[]> {
    if (assignmentIds.length === 0) return [];
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `UPDATE job_assignments SET last_seen_at = now()
        WHERE worker_id = $1 AND id = ANY($2::uuid[]) AND status IN ('assigned', 'running') RETURNING id`,
      [workerId, assignmentIds],
    );
    const alive = new Set(rows.map((r) => r.id));
    return assignmentIds.filter((id) => !alive.has(id));
  }

  // ---- monitors -------------------------------------------------------------------

  /** Offers not accepted in time → re-route. */
  async expireUnaccepted(): Promise<number> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM job_assignments WHERE status = 'assigned' AND accept_deadline < now() LIMIT 500`,
    );
    let n = 0;
    for (const { id } of rows)
      if (await this.endInternal(id, { kind: 'expired' }, 'not accepted in time', (a) => a.status === 'assigned' && a.accept_deadline < new Date())) n++;
    return n;
  }

  /** Running assignments the worker stopped reporting → re-route. */
  async reclaimStale(): Promise<number> {
    const stale = this.ctx.config.ASSIGNMENT_STALE_SECONDS;
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM job_assignments
        WHERE status = 'running' AND last_seen_at < now() - make_interval(secs => $1) LIMIT 500`,
      [stale],
    );
    let n = 0;
    const cutoff = () => new Date(Date.now() - stale * 1000);
    for (const { id } of rows)
      if (await this.endInternal(id, { kind: 'lost' }, 'worker stopped reporting the job', (a) => a.status === 'running' && (a.last_seen_at ?? new Date(0)) < cutoff())) n++;
    return n;
  }

  /** Attempts running longer than the job's timeout → TIMEOUT (terminal). */
  async enforceTimeouts(): Promise<number> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT a.id FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.status = 'running' AND a.started_at + make_interval(secs => j.timeout_seconds) < now() LIMIT 500`,
    );
    let n = 0;
    for (const { id } of rows) {
      const res = await withTx(this.ctx.db, async (c) => {
        const chain = await lockChain(c, id);
        if (!chain || chain.a.status !== 'running' || !chain.a.started_at) return null;
        if (chain.a.started_at.getTime() + chain.job.timeout_seconds * 1000 > Date.now()) return null;
        const { job, a } = chain;
        if (job.retry_on_timeout) {
          // Resumable: retry (from the checkpoint) like any other lost attempt.
          const r = await this.endAttempt(c, job, a, { kind: 'timeout' }, `exceeded ${job.timeout_seconds}s`);
          r.cancelOnWorker = { workerId: a.worker_id, assignmentId: a.id, reason: 'timeout' };
          return r;
        }
        const err = { code: 'TIMEOUT', message: `exceeded ${job.timeout_seconds}s` };
        await c.query(`UPDATE job_assignments SET status = 'timeout', finished_at = now(), error = $2 WHERE id = $1`, [a.id, err.message]);
        await c.query(
          `UPDATE jobs SET status = 'TIMEOUT', error = $2, failures = failures + 1, finished_at = now(), updated_at = now() WHERE id = $1`,
          [job.id, err],
        );
        await event(c, job.id, a.id, a.worker_id, 'job.timeout', err);
        await settleJob(c, job.id);
        return {
          jobId: job.id,
          status: 'TIMEOUT' as const,
          workerId: a.worker_id,
          assignmentId: a.id,
          cancelOnWorker: { workerId: a.worker_id, assignmentId: a.id, reason: 'timeout' },
        };
      });
      if (res) {
        await this.after(res);
        n++;
      }
    }
    return n;
  }

  /** Worker offline or revoked: every active attempt is lost and re-routed. */
  async releaseWorker(workerId: string, reason: string): Promise<number> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM job_assignments WHERE worker_id = $1 AND status IN ('assigned', 'running')`,
      [workerId],
    );
    let n = 0;
    for (const { id } of rows) if (await this.endInternal(id, { kind: 'lost' }, reason, (a) => ACTIVE.includes(a.status), true)) n++;
    return n;
  }

  // ---- owner --------------------------------------------------------------------------

  async cancel(jobId: string, reason: string) {
    const res = await withTx(this.ctx.db, async (c) => {
      const job = (await c.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId])).rows[0];
      if (!job) throw notFound('Job');
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(job.status)) throw conflict(`Job is already ${job.status}`);
      const a = (
        await c.query<AssignmentRow>(
          `UPDATE job_assignments SET status = 'cancelled', finished_at = now(), error = $2
            WHERE job_id = $1 AND status IN ('assigned', 'running') RETURNING *`,
          [jobId, reason],
        )
      ).rows[0];
      await c.query(
        `UPDATE jobs SET status = 'CANCELLED', error = $2, finished_at = now(), updated_at = now() WHERE id = $1`,
        [jobId, { code: 'CANCELLED', message: reason }],
      );
      await event(c, jobId, a?.id ?? null, a?.worker_id ?? null, 'job.cancelled', { reason });
      await settleJob(c, jobId);
      return {
        jobId,
        status: 'CANCELLED' as const,
        workerId: a?.worker_id ?? null,
        dequeue: true,
        ...(a ? { cancelOnWorker: { workerId: a.worker_id, assignmentId: a.id, reason: 'job cancelled' } } : {}),
      };
    });
    await this.after(res);
  }

  // ---- internals ----------------------------------------------------------------------

  private async lockOwned(c: pg.PoolClient, workerId: string, assignmentId: string) {
    const chain = await lockChain(c, assignmentId);
    // Same answer for "missing" and "someone else's": do not leak ids.
    if (!chain || chain.a.worker_id !== workerId) throw notFound('Assignment');
    return chain;
  }

  private async endOwned(workerId: string, assignmentId: string, outcome: AttemptOutcome, error: string, from: string[]) {
    const res = await withTx(this.ctx.db, async (c) => {
      const chain = await this.lockOwned(c, workerId, assignmentId);
      if (!from.includes(chain.a.status)) throw notActive();
      return this.endAttempt(c, chain.job, chain.a, outcome, error);
    });
    await this.after(res);
    return { assignmentId, jobStatus: res.status };
  }

  private async endInternal(
    assignmentId: string,
    outcome: AttemptOutcome,
    error: string,
    stillValid: (a: AssignmentRow) => boolean,
    notifyWorker = false,
  ): Promise<boolean> {
    const res = await withTx(this.ctx.db, async (c) => {
      const chain = await lockChain(c, assignmentId);
      if (!chain || !stillValid(chain.a)) return null;
      const r = await this.endAttempt(c, chain.job, chain.a, outcome, error);
      if (notifyWorker) r.cancelOnWorker = { workerId: chain.a.worker_id, assignmentId, reason: error };
      return r;
    });
    if (!res) return false;
    await this.after(res);
    return true;
  }

  /** Ends an attempt and applies the retry policy. Caller holds job + assignment locks. */
  private async endAttempt(c: pg.PoolClient, job: JobRow, a: AssignmentRow, o: AttemptOutcome, error: string): Promise<After> {
    await c.query(`UPDATE job_assignments SET status = $2, finished_at = now(), error = $3, retryable = $4 WHERE id = $1`, [
      a.id,
      o.kind,
      error,
      o.kind === 'failed' ? o.retryable : null,
    ]);
    const failures = job.failures + (countsAsFailure(o.kind) ? 1 : 0);
    let decision = this.policy.decide(o, failures, job.max_attempts);
    // Verified jobs get a second opinion before "the job itself is bad" is believed: a
    // provider could otherwise fail every job it dislikes at no cost.
    if (decision === 'FAIL' && o.kind === 'failed' && !o.retryable && job.verification === 'replicate' && failures < job.max_attempts) {
      const prev = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_assignments WHERE job_id = $1 AND id <> $2 AND status = 'failed' AND retryable = false`,
        [job.id, a.id],
      );
      if (prev.rows[0]!.n === 0) decision = 'REQUEUE';
    }
    const base = { jobId: job.id, workerId: a.worker_id, assignmentId: a.id };
    if (decision === 'REQUEUE') {
      await c.query(
        `UPDATE jobs SET status = 'QUEUED', failures = $2, worker_id = NULL, assigned_at = NULL, progress = 0, stage = NULL,
                         updated_at = now() WHERE id = $1`,
        [job.id, failures],
      );
      await event(c, job.id, a.id, a.worker_id, `attempt.${o.kind}`, { error, failures, decision });
      return { ...base, status: 'QUEUED', requeue: { priority: job.priority, createdAt: job.created_at }, extra: { attempt: o.kind } };
    }
    const err =
      o.kind === 'failed' && !o.retryable
        ? { code: 'JOB_FAILED', message: error }
        : o.kind === 'timeout'
          ? { code: 'TIMEOUT', message: `${failures} attempt(s) timed out; last: ${error}` }
          : { code: 'MAX_ATTEMPTS', message: `${failures} failed attempt(s); last: ${o.kind}: ${error}` };
    const status: JobStatus = o.kind === 'timeout' ? 'TIMEOUT' : 'FAILED';
    await c.query(
      `UPDATE jobs SET status = $4, failures = $2, error = $3, finished_at = now(), updated_at = now() WHERE id = $1`,
      [job.id, failures, err, status],
    );
    await event(c, job.id, a.id, a.worker_id, status === 'TIMEOUT' ? 'job.timeout' : 'job.failed', { ...err, attempt: o.kind });
    await settleJob(c, job.id);
    return { ...base, status };
  }

  private async after(r: After) {
    if (r.requeue) await this.ctx.queue.enqueue([{ jobId: r.jobId, ...r.requeue }]).catch(() => {});
    if (r.dequeue) await this.ctx.queue.remove([r.jobId]).catch(() => {});
    if (r.cancelOnWorker)
      await this.ctx.bus.sendToWorker(r.cancelOnWorker.workerId, {
        type: 'assignment.cancel',
        assignmentId: r.cancelOnWorker.assignmentId,
        reason: r.cancelOnWorker.reason,
      });
    await this.ctx.bus.publish('job.updated', {
      jobId: r.jobId,
      status: r.status,
      workerId: r.workerId,
      assignmentId: r.assignmentId,
      ...r.extra,
    });
    if (TERMINAL.includes(r.status)) await this.onTerminal(r.jobId);
  }
}

/** Items this attempt processed and how long it took (image-inference only). */
function observe(type: string, output: unknown, startedAt: Date | null) {
  if (type !== 'image-inference' || !startedAt || typeof output !== 'object' || output === null) return null;
  const o = output as { count?: unknown; resumed?: unknown };
  const items = (typeof o.count === 'number' ? o.count : 0) - (typeof o.resumed === 'number' ? o.resumed : 0);
  const seconds = (Date.now() - startedAt.getTime()) / 1000;
  return items > 0 && seconds > 0 ? { type, items, seconds } : null;
}

async function lockChain(c: pg.PoolClient, assignmentId: string) {
  const ref = await c.query<{ job_id: string }>(`SELECT job_id FROM job_assignments WHERE id = $1`, [assignmentId]);
  const jobId = ref.rows[0]?.job_id;
  if (!jobId) return null;
  const job = (await c.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId])).rows[0]!;
  const a = (await c.query<AssignmentRow>(`SELECT * FROM job_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])).rows[0]!;
  return { job, a };
}

async function event(
  c: pg.PoolClient,
  jobId: string,
  assignmentId: string | null,
  workerId: string | null,
  type: string,
  payload: Record<string, unknown>,
) {
  await c.query(
    `INSERT INTO job_events (job_id, assignment_id, worker_id, type, payload) VALUES ($1, $2, $3, $4, $5)`,
    [jobId, assignmentId, workerId, type, payload],
  );
}
