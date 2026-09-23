import type { AppContext } from '../../context.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { refreshJob } from '../leases/service.js';
import type { Requirements } from '../schemas.js';

export interface CreateJobInput {
  name: string;
  module: { name: string; version: string };
  params: unknown;
  requirements: Requirements;
  priority: number;
  maxRetries: number;
  inputs: unknown[];
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

export function toJobDto(r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    module: { name: r.module_name, version: r.module_version },
    params: r.params,
    requirements: r.requirements,
    priority: r.priority,
    maxRetries: r.max_retries,
    status: r.status,
    totalTasks: r.total_tasks,
    succeededTasks: r.succeeded_tasks,
    failedTasks: r.failed_tasks,
    cancelledTasks: r.cancelled_tasks,
    cancelReason: r.cancel_reason,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

function toTaskDto(r: Record<string, any>) {
  return {
    id: r.id,
    index: r.idx,
    status: r.status,
    attempts: r.attempts,
    progress: r.progress,
    input: r.input,
    output: r.output,
    outputSha256: r.output_sha256,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

// Keyset cursor over (created_at DESC, id DESC).
const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0])))
      return [v[0], v[1]];
  } catch {
    /* fallthrough */
  }
  throw badRequest('Invalid cursor');
}

export class JobService {
  constructor(private readonly ctx: AppContext) {}

  async create(input: CreateJobInput, actorId: string) {
    if (input.inputs.length > this.ctx.config.MAX_TASKS_PER_JOB)
      throw badRequest(`A job may have at most ${this.ctx.config.MAX_TASKS_PER_JOB} tasks`);

    const { job, tasks } = await withTx(this.ctx.db, async (c) => {
      const j = await c.query(
        `INSERT INTO jobs (name, module_name, module_version, params, requirements, priority, max_retries,
                           total_tasks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          input.name,
          input.module.name,
          input.module.version,
          JSON.stringify(input.params ?? {}),
          input.requirements,
          input.priority,
          input.maxRetries,
          input.inputs.length,
          actorId,
        ],
      );
      const job = j.rows[0];
      const t = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO tasks (job_id, idx, input)
         SELECT $1, (e.ord - 1)::int, e.value FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(value, ord)
         RETURNING id, created_at`,
        [job.id, JSON.stringify(input.inputs)],
      );
      await c.query(`INSERT INTO task_events (job_id, type, payload) VALUES ($1, 'job.created', $2)`, [
        job.id,
        { totalTasks: input.inputs.length },
      ]);
      await audit(c, {
        actorType: 'user',
        actorId,
        action: 'job.create',
        targetType: 'job',
        targetId: job.id,
        details: { module: input.module, tasks: input.inputs.length },
      });
      return { job, tasks: t.rows };
    });

    // After commit. If this fails the reconciler re-enqueues pending tasks.
    await this.ctx.queue
      .enqueue(tasks.map((t) => ({ taskId: t.id, priority: input.priority, createdAt: t.created_at })))
      .catch(() => {});
    const dto = toJobDto(job);
    await this.ctx.bus.publish('job.created', { job: dto });
    return dto;
  }

  async get(jobId: string) {
    const { rows } = await this.ctx.db.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
    if (!rows[0]) throw notFound('Job');
    const counts = await this.ctx.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tasks WHERE job_id = $1 GROUP BY status`,
      [jobId],
    );
    const taskCounts: Record<string, number> = {
      pending: 0,
      leased: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const r of counts.rows) taskCounts[r.status] = r.n;
    const prog = await this.ctx.db.query<{ p: number | null }>(
      `SELECT avg(progress)::float AS p FROM tasks WHERE job_id = $1`,
      [jobId],
    );
    return { ...toJobDto(rows[0]), taskCounts, progress: prog.rows[0]?.p ?? 0 };
  }

  async list(f: {
    status?: string | undefined;
    createdBy?: string | undefined;
    moduleName?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const [cAt, cId] = f.cursor ? decodeCursor(f.cursor) : [null, null];
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM jobs
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::uuid IS NULL OR created_by = $2)
          AND ($3::text IS NULL OR module_name = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4)
          AND ($5::timestamptz IS NULL OR created_at < $5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6, $7::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $8`,
      [f.status ?? null, f.createdBy ?? null, f.moduleName ?? null, f.since ?? null, f.until ?? null, cAt, cId, f.limit + 1],
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toJobDto),
      nextCursor: rows.length > f.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async tasks(jobId: string, f: { status?: string | undefined; limit: number; offset: number }) {
    await this.assertExists(jobId);
    const { rows } = await this.ctx.db.query(
      `SELECT *, count(*) OVER ()::int AS total FROM tasks
        WHERE job_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY idx LIMIT $3 OFFSET $4`,
      [jobId, f.status ?? null, f.limit, f.offset],
    );
    return { items: rows.map(toTaskDto), total: rows[0]?.total ?? 0 };
  }

  async events(jobId: string, f: { afterId: number; limit: number }) {
    await this.assertExists(jobId);
    const { rows } = await this.ctx.db.query(
      `SELECT id, task_id, lease_id, worker_id, type, payload, created_at FROM task_events
        WHERE job_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [jobId, f.afterId, f.limit],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        taskId: r.task_id,
        leaseId: r.lease_id,
        workerId: r.worker_id,
        type: r.type,
        payload: r.payload,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  async cancel(jobId: string, reason: string, actorId: string) {
    const res = await withTx(this.ctx.db, async (c) => {
      const cur = await c.query(`SELECT status FROM jobs WHERE id = $1 FOR UPDATE`, [jobId]);
      if (!cur.rows[0]) throw notFound('Job');
      if (TERMINAL.includes(cur.rows[0].status)) throw conflict(`Job is already ${cur.rows[0].status}`);

      const tasks = await c.query<{ id: string }>(
        `UPDATE tasks SET status = 'cancelled', finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND status IN ('pending', 'leased', 'running') RETURNING id`,
        [jobId],
      );
      const leases = await c.query<{ id: string; worker_id: string }>(
        `UPDATE leases l SET status = 'cancelled', error = $2, finished_at = now()
           FROM tasks t WHERE t.id = l.task_id AND t.job_id = $1 AND l.status IN ('offered', 'running')
         RETURNING l.id, l.worker_id`,
        [jobId, reason],
      );
      await c.query(
        `UPDATE jobs SET status = 'cancelled', cancel_reason = $2, finished_at = now() WHERE id = $1`,
        [jobId, reason],
      );
      await refreshJob(c, jobId);
      await c.query(`INSERT INTO task_events (job_id, type, payload) VALUES ($1, 'job.cancelled', $2)`, [
        jobId,
        { reason, cancelledTasks: tasks.rowCount },
      ]);
      await audit(c, {
        actorType: 'user',
        actorId,
        action: 'job.cancel',
        targetType: 'job',
        targetId: jobId,
        details: { reason },
      });
      return { taskIds: tasks.rows.map((r) => r.id), leases: leases.rows };
    });

    await this.ctx.queue.remove(res.taskIds);
    for (const l of res.leases)
      await this.ctx.bus.sendToWorker(l.worker_id, { type: 'lease.cancel', leaseId: l.id, reason: 'job cancelled' });
    const job = await this.get(jobId);
    await this.ctx.bus.publish('job.cancelled', { jobId, reason });
    return job;
  }

  private async assertExists(jobId: string) {
    const { rows } = await this.ctx.db.query(`SELECT 1 FROM jobs WHERE id = $1`, [jobId]);
    if (!rows[0]) throw notFound('Job');
  }
}
