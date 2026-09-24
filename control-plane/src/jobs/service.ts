import type { AppContext } from '../context.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { Role } from '../auth/plugin.js';
import type { CreateJobInput } from './schemas.js';
import { JobLifecycle } from './lifecycle.js';
import { withTx } from '../db/pool.js';
import { holdForJobs } from '../credits/service.js';

const JOB_COLS = `j.id, j.owner_id, u.email AS owner_email, j.name, j.type, j.requirements, j.resources, j.status,
  j.priority, j.timeout_seconds, j.max_attempts, j.failures, j.error, j.worker_id, j.progress, j.stage,
  j.pending_reason, j.output_sha256, j.created_at, j.assigned_at, j.started_at, j.finished_at, j.updated_at,
  (SELECT count(*)::int FROM job_assignments a WHERE a.job_id = j.id) AS attempts`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toDto(r: Record<string, any>, full = false) {
  return {
    id: r.id,
    owner: { id: r.owner_id, email: r.owner_email },
    name: r.name,
    type: r.type,
    requirements: r.requirements,
    resources: r.resources,
    status: r.status,
    priority: r.priority,
    timeout: r.timeout_seconds,
    maxAttempts: r.max_attempts,
    attempts: r.attempts,
    failures: r.failures,
    workerId: r.worker_id,
    progress: r.progress,
    stage: r.stage,
    pendingReason: r.pending_reason,
    error: r.error,
    createdAt: iso(r.created_at),
    assignedAt: iso(r.assigned_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: iso(r.updated_at),
    ...(full ? { input: r.input, output: r.output ?? null, outputSha256: r.output_sha256 } : {}),
  };
}

const encodeCursor = (d: Date, id: string) => Buffer.from(JSON.stringify([d.toISOString(), id])).toString('base64url');
function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0])))
      return [v[0], v[1]];
  } catch {
    /* fallthrough */
  }
  throw badRequest('Invalid cursor');
}

export class JobService {
  private readonly lifecycle: JobLifecycle;

  constructor(private readonly ctx: AppContext) {
    this.lifecycle = new JobLifecycle(ctx);
  }

  async create(input: CreateJobInput, ownerId: string) {
    const timeout = input.timeout ?? this.ctx.config.JOB_DEFAULT_TIMEOUT_SECONDS;
    // Job + credit hold commit together: no credits, no job.
    const { id, created_at } = await withTx(this.ctx.db, async (c) => {
      const { rows } = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO jobs (owner_id, name, type, requirements, resources, priority, timeout_seconds, max_attempts, input)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
        [
          ownerId,
          input.name ?? null,
          input.type,
          input.requirements,
          input.resources,
          input.priority,
          timeout,
          input.maxAttempts,
          JSON.stringify(input.input),
        ],
      );
      const row = rows[0]!;
      await c.query(`INSERT INTO job_events (job_id, type, payload) VALUES ($1, 'job.created', $2)`, [
        row.id,
        { type: input.type, priority: input.priority },
      ]);
      await holdForJobs(c, ownerId, [{ jobId: row.id, resources: input.resources, timeoutSeconds: timeout }]);
      return row;
    });
    await audit(this.ctx.db, {
      actorType: 'user',
      actorId: ownerId,
      action: 'job.create',
      targetType: 'job',
      targetId: id,
      details: { type: input.type },
    });
    // After commit; the reconciler repairs the index if this fails.
    await this.ctx.queue.enqueue([{ jobId: id, priority: input.priority, createdAt: created_at }]).catch(() => {});
    const job = await this.get(id);
    await this.ctx.bus.publish('job.created', { jobId: id, job: { ...job, input: undefined, output: undefined } });
    return job;
  }

  async get(id: string) {
    const { rows } = await this.ctx.db.query(
      `SELECT ${JOB_COLS}, j.input, j.output FROM jobs j JOIN users u ON u.id = j.owner_id WHERE j.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Job');
    const a = await this.ctx.db.query(
      `SELECT id, worker_id, attempt, status, strategy, score, score_detail, assigned_at, started_at, finished_at, error
         FROM job_assignments WHERE job_id = $1 ORDER BY attempt`,
      [id],
    );
    const d = await this.ctx.db.query<{ summary: string }>(
      `SELECT summary FROM scheduler_decisions WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    return {
      ...toDto(rows[0], true),
      /** Latest "Worker X foi escolhido porque ..." (full history: /decisions). */
      placementReason: d.rows[0]?.summary ?? null,
      assignments: a.rows.map((r) => ({
        id: r.id,
        workerId: r.worker_id,
        attempt: r.attempt,
        status: r.status,
        strategy: r.strategy,
        score: r.score,
        scoreDetail: r.score_detail,
        assignedAt: iso(r.assigned_at),
        startedAt: iso(r.started_at),
        finishedAt: iso(r.finished_at),
        error: r.error,
      })),
    };
  }

  async list(f: {
    status?: string | undefined;
    type?: string | undefined;
    ownerId?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const [cAt, cId] = f.cursor ? decodeCursor(f.cursor) : [null, null];
    const { rows } = await this.ctx.db.query(
      `SELECT ${JOB_COLS} FROM jobs j JOIN users u ON u.id = j.owner_id
        WHERE ($1::text IS NULL OR j.status = $1)
          AND ($2::text IS NULL OR j.type = $2)
          AND ($3::uuid IS NULL OR j.owner_id = $3)
          AND ($4::timestamptz IS NULL OR j.created_at >= $4)
          AND ($5::timestamptz IS NULL OR j.created_at < $5)
          AND ($6::timestamptz IS NULL OR (j.created_at, j.id) < ($6, $7::uuid))
        ORDER BY j.created_at DESC, j.id DESC LIMIT $8`,
      [f.status ?? null, f.type ?? null, f.ownerId ?? null, f.since ?? null, f.until ?? null, cAt, cId, f.limit + 1],
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDto(r)),
      nextCursor: rows.length > f.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** Why each attempt went where it went. */
  async decisions(id: string) {
    await this.assertExists(id);
    const { rows } = await this.ctx.db.query(
      `SELECT id, assignment_id, worker_id, strategy, score, summary, explanation, created_at
         FROM scheduler_decisions WHERE job_id = $1 ORDER BY id`,
      [id],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        assignmentId: r.assignment_id,
        workerId: r.worker_id,
        strategy: r.strategy,
        score: r.score,
        summary: r.summary,
        explanation: r.explanation,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  async events(id: string, afterId: number, limit: number) {
    await this.assertExists(id);
    const { rows } = await this.ctx.db.query(
      `SELECT id, assignment_id, worker_id, type, payload, created_at FROM job_events
        WHERE job_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [id, afterId, limit],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        assignmentId: r.assignment_id,
        workerId: r.worker_id,
        type: r.type,
        payload: r.payload,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** Owners cancel their own jobs; admins any job. */
  async cancel(id: string, reason: string, actor: { userId: string; role: Role }) {
    const { rows } = await this.ctx.db.query<{ owner_id: string }>(`SELECT owner_id FROM jobs WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Job');
    if (rows[0].owner_id !== actor.userId && actor.role !== 'admin') throw forbidden('Only the owner or an admin can cancel');
    await this.lifecycle.cancel(id, reason);
    await audit(this.ctx.db, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'job.cancel',
      targetType: 'job',
      targetId: id,
      details: { reason },
    });
    return this.get(id);
  }

  private async assertExists(id: string) {
    const { rows } = await this.ctx.db.query(`SELECT 1 FROM jobs WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Job');
  }
}
