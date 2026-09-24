// Inference runs: a dataset split into batches, one job per batch, combined at the end.
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { AppError, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import { holdForJobs } from '../credits/service.js';
import { combine, type BatchRow } from './aggregate.js';
import type { Actor } from './datasets.js';
import { MAX_BATCH_BYTES, MAX_BATCHES, type CreateInferenceInput } from './schemas.js';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];
const iso = (d: Date | null) => d?.toISOString() ?? null;

interface ImageMeta {
  idx: number;
  sha256: string;
  size: number;
}

/** Consecutive images, at most `batchSize` and `MAX_BATCH_BYTES` per batch. */
export function splitBatches(images: ImageMeta[], batchSize: number): ImageMeta[][] {
  const out: ImageMeta[][] = [];
  let cur: ImageMeta[] = [];
  let bytes = 0;
  for (const img of images) {
    if (cur.length > 0 && (cur.length >= batchSize || bytes + img.size > MAX_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(img);
    bytes += img.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export class InferenceService {
  constructor(private readonly ctx: AppContext) {}

  async create(input: CreateInferenceInput, actor: Actor) {
    const { groupId, jobs } = await withTx(this.ctx.db, async (c) => {
      const d = (await c.query(`SELECT * FROM datasets WHERE id = $1 FOR SHARE`, [input.datasetId])).rows[0];
      if (!d || d.owner_id !== actor.userId) throw notFound('Dataset');
      if (d.status !== 'SEALED') throw conflict('Seal the dataset before running inference on it');
      const images = (
        await c.query<ImageMeta>(`SELECT idx, sha256, size FROM dataset_images WHERE dataset_id = $1 ORDER BY idx`, [d.id])
      ).rows;
      const batches = splitBatches(images, input.batchSize);
      if (batches.length > MAX_BATCHES)
        throw new AppError(422, 'TOO_MANY_BATCHES', `At most ${MAX_BATCHES} batches; use a larger batchSize`);

      const params = {
        batchSize: input.batchSize,
        accelerator: input.accelerator,
        topK: input.topK,
        priority: input.priority,
        timeoutSeconds: input.timeoutSeconds,
        maxAttempts: input.maxAttempts,
      };
      const g = (
        await c.query<{ id: string }>(
          `INSERT INTO job_groups (owner_id, kind, name, dataset_id, params, total_batches, total_items)
           VALUES ($1, 'image-inference', $2, $3, $4, $5, $6) RETURNING id`,
          [actor.userId, input.name ?? null, d.id, params, batches.length, images.length],
        )
      ).rows[0]!;

      // GPU requested: NVIDIA worker with a shared GPU. "auto": any worker, GPU used if present.
      const gpu = input.accelerator === 'gpu';
      const requirements = gpu ? { gpuVendor: 'NVIDIA' } : {};
      const resources = { cpuCores: 1, ramMb: 512, gpu, vramMb: 0, diskMb: 0 };
      const rows = batches.map((b, i) => ({
        name: `${input.name ?? 'inference'} · batch ${i + 1}/${batches.length}`,
        batch_index: i,
        input: {
          images: b.map((x) => ({ index: x.idx, sha256: x.sha256, size: x.size })),
          accelerator: input.accelerator,
          topK: input.topK,
        },
      }));
      const created = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO jobs (owner_id, name, type, requirements, resources, priority, timeout_seconds, max_attempts,
                           input, group_id, batch_index, retry_on_timeout)
         SELECT $1, r.name, 'image-inference', $2, $3, $4, $5, $6, r.input, $7, r.batch_index, true
           FROM jsonb_to_recordset($8::jsonb) AS r(name text, batch_index int, input jsonb)
         RETURNING id, created_at`,
        [actor.userId, requirements, resources, input.priority, input.timeoutSeconds, input.maxAttempts, g.id, JSON.stringify(rows)],
      );
      await c.query(
        `INSERT INTO job_events (job_id, type, payload)
         SELECT id, 'job.created', jsonb_build_object('type', 'image-inference', 'groupId', $2::text) FROM unnest($1::uuid[]) AS id`,
        [created.rows.map((r) => r.id), g.id],
      );
      await holdForJobs(
        c,
        actor.userId,
        created.rows.map((j) => ({ jobId: j.id, resources, timeoutSeconds: input.timeoutSeconds })),
      );
      return { groupId: g.id, jobs: created.rows };
    });
    await audit(this.ctx.db, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'inference.create',
      targetType: 'job_group',
      targetId: groupId,
      details: { datasetId: input.datasetId, batches: jobs.length },
    });
    await this.ctx.queue
      .enqueue(jobs.map((j) => ({ jobId: j.id, priority: input.priority, createdAt: j.created_at })))
      .catch(() => {});
    await this.ctx.bus.publish('inference.created', { groupId, batches: jobs.length });
    return this.get(groupId, actor);
  }

  private async load(id: string, actor: Actor) {
    const { rows } = await this.ctx.db.query(`SELECT * FROM job_groups WHERE id = $1`, [id]);
    const g = rows[0];
    if (!g || (g.owner_id !== actor.userId && actor.role !== 'admin')) throw notFound('Inference run');
    return g;
  }

  async get(id: string, actor: Actor) {
    const g = await this.load(id, actor);
    const { rows } = await this.ctx.db.query(
      `SELECT status, count(*)::int AS n,
              sum(CASE WHEN status = 'COMPLETED' THEN jsonb_array_length(input->'images')
                       ELSE COALESCE(jsonb_array_length(checkpoint->'items'), 0) END)::int AS done
         FROM jobs WHERE group_id = $1 GROUP BY status`,
      [id],
    );
    const batches: Record<string, number> = {};
    let processed = 0;
    for (const r of rows) {
      batches[r.status] = r.n;
      processed += r.done;
    }
    return {
      id: g.id,
      name: g.name,
      datasetId: g.dataset_id,
      status: g.status,
      params: g.params,
      totalBatches: g.total_batches,
      totalImages: g.total_items,
      progress: {
        processedImages: processed,
        fraction: g.total_items ? Math.min(1, processed / g.total_items) : 0,
        batches,
      },
      resultAvailable: g.result !== null,
      resultSha256: g.result_sha256,
      createdAt: iso(g.created_at),
      finishedAt: iso(g.finished_at),
      updatedAt: iso(g.updated_at),
    };
  }

  async list(ownerId: string) {
    const { rows } = await this.ctx.db.query(
      `SELECT id FROM job_groups WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [ownerId],
    );
    return { items: await Promise.all(rows.map((r) => this.get(r.id, { userId: ownerId, role: 'viewer' }))) };
  }

  async result(id: string, actor: Actor) {
    const g = await this.load(id, actor);
    if (g.result === null) throw new AppError(409, 'NOT_READY', `Inference run is ${g.status}; result not available yet`);
    return { id: g.id, resultSha256: g.result_sha256, ...g.result };
  }

  async cancel(id: string, actor: Actor, reason: string) {
    const g = await this.load(id, actor);
    if (g.status !== 'RUNNING') throw conflict(`Inference run is already ${g.status}`);
    await this.ctx.db.query(`UPDATE job_groups SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status = 'RUNNING'`, [id]);
    // Lazy import: lifecycle imports this module for its terminal hook.
    const { JobLifecycle } = await import('../jobs/lifecycle.js');
    const lc = new JobLifecycle(this.ctx);
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE group_id = $1 AND status <> ALL($2::text[])`,
      [id, TERMINAL],
    );
    for (const j of rows) await lc.cancel(j.id, reason).catch(() => {}); // may have just finished
    await refreshGroup(this.ctx, id);
    await audit(this.ctx.db, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'inference.cancel',
      targetType: 'job_group',
      targetId: id,
      details: { reason },
    });
    return this.get(id, actor);
  }

  /** Image bytes for a worker: only its own running assignment, only images of that batch. */
  async imageForAssignment(workerId: string, assignmentId: string, index: number) {
    const { rows } = await this.ctx.db.query(
      `SELECT a.worker_id, a.status, j.input, g.dataset_id
         FROM job_assignments a JOIN jobs j ON j.id = a.job_id JOIN job_groups g ON g.id = j.group_id
        WHERE a.id = $1`,
      [assignmentId],
    );
    const a = rows[0];
    if (!a || a.worker_id !== workerId) throw notFound('Assignment');
    if (a.status !== 'running') throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'Assignment is no longer active');
    const ref = (a.input?.images ?? []).find((i: { index: number }) => i.index === index);
    if (!ref) throw notFound('Image');
    const img = (
      await this.ctx.db.query<{ data: Buffer; sha256: string }>(
        `SELECT data, sha256 FROM dataset_images WHERE dataset_id = $1 AND idx = $2`,
        [a.dataset_id, index],
      )
    ).rows[0];
    if (!img || img.sha256 !== ref.sha256) throw notFound('Image');
    return img;
  }
}

/** Terminal hook of the job lifecycle. */
export async function refreshGroupForJob(ctx: AppContext, jobId: string) {
  const { rows } = await ctx.db.query<{ group_id: string | null }>(`SELECT group_id FROM jobs WHERE id = $1`, [jobId]);
  const groupId = rows[0]?.group_id;
  if (groupId) await refreshGroup(ctx, groupId);
}

/** Once every batch is terminal, combines them and stores the final result (once). */
export async function refreshGroup(ctx: AppContext, groupId: string) {
  const done = await withTx(ctx.db, async (c) => {
    const g = (await c.query(`SELECT * FROM job_groups WHERE id = $1 FOR UPDATE`, [groupId])).rows[0];
    if (!g || g.result !== null) return null;
    const open = await c.query(
      `SELECT 1 FROM jobs WHERE group_id = $1 AND status <> ALL($2::text[]) LIMIT 1`,
      [groupId, TERMINAL],
    );
    if (open.rows[0]) return null;
    const batches = (
      await c.query(
        `SELECT j.id, j.batch_index, j.status, j.input, j.output, j.checkpoint, j.error, j.worker_id,
                (SELECT count(*)::int FROM job_assignments a WHERE a.job_id = j.id) AS attempts
           FROM jobs j WHERE j.group_id = $1`,
        [groupId],
      )
    ).rows.map(
      (r): BatchRow => ({
        jobId: r.id,
        batchIndex: r.batch_index,
        status: r.status,
        input: r.input,
        output: r.output,
        checkpoint: r.checkpoint,
        error: r.error,
        workerId: r.worker_id,
        attempts: r.attempts,
      }),
    );
    const names = new Map<number, string>(
      (
        await c.query<{ idx: number; name: string }>(
          `SELECT idx, name FROM dataset_images WHERE dataset_id = $1 AND name IS NOT NULL`,
          [g.dataset_id],
        )
      ).rows.map((r) => [r.idx, r.name]),
    );
    const { status, result } = combine(batches, names, g.status === 'CANCELLED');
    const sha = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    await c.query(
      `UPDATE job_groups SET status = $2, result = $3, result_sha256 = $4, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [groupId, status, JSON.stringify(result), sha],
    );
    return { status, summary: result.summary };
  });
  if (done) await ctx.bus.publish('inference.finished', { groupId, ...done });
}
