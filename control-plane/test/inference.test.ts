import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, heartbeat, makeUser, registerWorker, reset, setup, type Harness, type TestWorker } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import type { SchedulerEngine } from '../src/scheduler/index.js';
import { combine } from '../src/inference/aggregate.js';
import { splitBatches } from '../src/inference/groups.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../workloads/image-inference/testdata');
const PNGS = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.png'))
  .sort()
  .map((f) => ({ name: f, data: readFileSync(path.join(FIXTURES, f)), label: Number(f.split('label')[1]![0]) }));
const JPEG = readFileSync(path.join(FIXTURES, readdirSync(FIXTURES).find((f) => f.endsWith('.jpg'))!));

let h: Harness;
let op: string;
let other: string;
let engine: SchedulerEngine;
beforeAll(async () => {
  h = await setup();
  engine = createEngine(h.rt);
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
  other = await makeUser(h, 'operator', 'other@ghost.test');
});
afterAll(() => h.close());

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const req = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  h.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
const upload = (token: string, id: string, data: Buffer, type = 'image/png', name?: string) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/datasets/${id}/images${name ? `?name=${encodeURIComponent(name)}` : ''}`,
    headers: { ...auth(token), 'content-type': type },
    payload: data,
  });

async function dataset(n: number, token = op) {
  const d = (await req(token, 'POST', '/v1/datasets', { name: 'digits' })).json();
  for (const img of PNGS.slice(0, n)) expect((await upload(token, d.id, img.data, 'image/png', img.name)).statusCode).toBe(201);
  expect((await req(token, 'POST', `/v1/datasets/${d.id}/seal`)).statusCode).toBe(200);
  return d.id as string;
}

const TYPES = ['benchmark', 'image-inference'];
async function worker(name: string, over: object = {}) {
  const w = await registerWorker(h, { name, maxConcurrentTasks: 8, ...over });
  await heartbeat(h, w, { workloadTypes: TYPES });
  return w;
}
const offers = async (w: TestWorker) =>
  (await heartbeat(h, w, { workloadTypes: TYPES })).json().assignments as {
    assignmentId: string;
    jobId: string;
    input: { images: { index: number; sha256: string; size: number }[]; topK: number };
    checkpoint?: { items: unknown[] };
  }[];
const wpost = (w: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(w.token), ...(payload ? { payload } : {}) });
const image = (w: TestWorker, a: string, i: number) =>
  h.app.inject({ url: `/v1/worker/assignments/${a}/images/${i}`, headers: auth(w.token) });

/** What a correct worker would answer for these indexes. */
const predict = (indexes: number[]) =>
  indexes.map((i) => ({ index: i, label: PNGS[i]!.label, confidenceBp: 9900, topK: [{ label: PNGS[i]!.label, confidenceBp: 9900 }] }));
const output = (indexes: number[], accelerator = 'cpu') => ({
  items: predict(indexes),
  count: indexes.length,
  failed: 0,
  resumed: 0,
  accelerator,
  model: 'digits-mlp-8x8',
});
async function complete(w: TestWorker, a: string, out: object) {
  const r = await wpost(w, `/v1/worker/assignments/${a}/result`, { status: 'completed', output: out, outputSha256: sha(out) });
  expect(r.statusCode, r.body).toBe(200);
}

describe('datasets', () => {
  it('accepts PNG and JPEG with matching content types only', async () => {
    const d = (await req(op, 'POST', '/v1/datasets', { name: 'mixed' })).json();
    const png = await upload(op, d.id, PNGS[0]!.data, 'image/png', 'a.png');
    expect(png.statusCode).toBe(201);
    expect(png.json()).toMatchObject({ index: 0, contentType: 'image/png', sha256: createHash('sha256').update(PNGS[0]!.data).digest('hex') });
    expect((await upload(op, d.id, JPEG, 'image/jpeg')).json().index).toBe(1);

    const refused: [Buffer, string, number][] = [
      [PNGS[0]!.data, 'image/jpeg', 415], // declared type does not match the bytes
      [Buffer.from('MZ\x90\0 fake exe'), 'image/png', 415],
      [Buffer.from('#!/bin/sh\nrm -rf /'), 'image/png', 415],
      [Buffer.from('GIF89a....'), 'image/gif', 415],
      [Buffer.from('{"a":1}'), 'application/json', 400],
      [Buffer.from('--x\r\n'), 'multipart/form-data; boundary=x', 415],
      [Buffer.alloc(8 * 1024 * 1024 + 1, 0xff), 'image/jpeg', 413],
    ];
    for (const [data, type, code] of refused) expect((await upload(op, d.id, data, type)).statusCode, type).toBe(code);
    expect((await req(op, 'GET', `/v1/datasets/${d.id}`)).json()).toMatchObject({ imageCount: 2, status: 'OPEN' });
  });

  it('is private to its owner and immutable once sealed', async () => {
    const id = await dataset(2);
    expect((await req(other, 'GET', `/v1/datasets/${id}`)).statusCode).toBe(404);
    expect((await upload(other, id, PNGS[0]!.data)).statusCode).toBe(404);
    expect((await upload(op, id, PNGS[0]!.data)).statusCode).toBe(409);
    expect((await req(op, 'POST', `/v1/datasets/${id}/seal`)).statusCode).toBe(409);
    const empty = (await req(op, 'POST', '/v1/datasets', { name: 'empty' })).json();
    expect((await req(op, 'POST', `/v1/datasets/${empty.id}/seal`)).statusCode).toBe(409);
    expect((await req(op, 'POST', '/v1/inference', { datasetId: empty.id })).statusCode).toBe(409);
    expect((await req(other, 'POST', '/v1/inference', { datasetId: id })).statusCode).toBe(404);
  });
});

describe('inference runs', () => {
  it('splits the dataset into batches of the requested size', async () => {
    const id = await dataset(10);
    const run = await req(op, 'POST', '/v1/inference', { datasetId: id, batchSize: 4, name: 'digits' });
    expect(run.statusCode, run.body).toBe(201);
    expect(run.json()).toMatchObject({ status: 'RUNNING', totalBatches: 3, totalImages: 10, progress: { processedImages: 0 } });
    const { rows } = await h.rt.db.query(
      `SELECT batch_index, type, input, resources, requirements, retry_on_timeout FROM jobs WHERE group_id = $1 ORDER BY batch_index`,
      [run.json().id],
    );
    expect(rows.map((r) => r.input.images.map((i: { index: number }) => i.index))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(rows[0]).toMatchObject({ type: 'image-inference', retry_on_timeout: true, resources: { gpu: false }, requirements: {} });
    expect(rows[0].input).toMatchObject({ accelerator: 'auto', topK: 3 });
    expect(await h.rt.queue.size()).toBe(3);
  });

  it('batches are also bounded by bytes', () => {
    const imgs = Array.from({ length: 5 }, (_, i) => ({ idx: i, sha256: 'x', size: 30 * 1024 * 1024 }));
    expect(splitBatches(imgs, 256).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(splitBatches(imgs.slice(0, 3), 1).length).toBe(3);
  });

  it('image-inference jobs cannot be created directly', async () => {
    const r = await req(op, 'POST', '/v1/jobs', {
      type: 'image-inference',
      input: { images: [{ index: 0, sha256: 'a'.repeat(64), size: 10 }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('POST /v1/inference');
  });

  it('GPU runs go to NVIDIA workers that share their GPU', async () => {
    const id = await dataset(2);
    const run = (await req(op, 'POST', '/v1/inference', { datasetId: id, accelerator: 'gpu' })).json();
    const cpuOnly = await worker('cpu-only');
    await engine.tick();
    const job = (await h.rt.db.query(`SELECT * FROM jobs WHERE group_id = $1`, [run.id])).rows[0];
    expect(job).toMatchObject({ status: 'QUEUED', requirements: { gpuVendor: 'NVIDIA' }, resources: { gpu: true } });
    expect(job.pending_reason).toMatch(/NO_GPU/);
    expect(await offers(cpuOnly)).toEqual([]);

    const gpuHw = { cpu: { model: 'x', cores: 8, threads: 16, features: [] }, ramMb: 16384, os: { name: 'Windows', version: '11' },
      gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', vramMb: 12288 }] };
    const g = await registerWorker(h, { name: 'rtx', hardware: gpuHw, maxConcurrentTasks: 4 });
    await heartbeat(h, g, { workloadTypes: TYPES, capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: 80, vramMb: 12288, diskMb: 1000, maxTemperatureC: 85 } });
    await engine.tick();
    expect((await h.rt.db.query(`SELECT worker_id FROM jobs WHERE id = $1`, [job.id])).rows[0].worker_id).toBe(g.id);
  });

  it('end to end: images served per batch, checkpoint on failure, retry resumes, results combined', async () => {
    const id = await dataset(6);
    const run = (await req(op, 'POST', '/v1/inference', { datasetId: id, batchSize: 3, topK: 1, maxAttempts: 3 })).json();
    const a = await worker('a');
    const b = await worker('b');
    await engine.tick();

    const all = [...(await offers(a)).map((o) => ({ w: a, o })), ...(await offers(b)).map((o) => ({ w: b, o }))];
    expect(all).toHaveLength(2);
    for (const { w, o } of all) expect((await wpost(w, `/v1/worker/assignments/${o.assignmentId}/accept`)).statusCode).toBe(200);
    const [first, second] = all.sort((x, y) => x.o.input.images[0]!.index - y.o.input.images[0]!.index);

    // Images: only the worker's own running assignment, only its batch.
    const img = await image(first!.w, first!.o.assignmentId, 1);
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(PNGS[1]!.data)).toBe(true);
    expect(img.headers['x-content-sha256']).toBe(first!.o.input.images[1]!.sha256);
    expect((await image(first!.w, first!.o.assignmentId, 4)).statusCode).toBe(404); // other batch
    expect((await image(second!.w, first!.o.assignmentId, 1)).statusCode).toBe(404); // other worker
    expect((await req(op, 'GET', `/v1/worker/assignments/${first!.o.assignmentId}/images/1`)).statusCode).toBe(401);

    // Batch 1 completes on its worker.
    await complete(first!.w, first!.o.assignmentId, output([0, 1, 2]));

    // Batch 2 saves a checkpoint, then its worker fails.
    const s = second!;
    const cp = { items: predict([3]) };
    const bad = [
      { items: predict([0]) }, // not this batch
      { items: [...predict([3]), ...predict([3])] }, // duplicate
      { items: [{ index: 4, label: 11, confidenceBp: 1, topK: [{ label: 11, confidenceBp: 1 }] }] },
      { items: predict([4]), extra: 'x' },
      { items: [{ index: 4, label: 1, confidenceBp: 1, topK: [{ label: 1, confidenceBp: 1 }, { label: 2, confidenceBp: 0 }] }] }, // topK > 1
    ];
    for (const c of bad) {
      const r = await wpost(s.w, `/v1/worker/assignments/${s.o.assignmentId}/progress`, { progress: 0.3, checkpoint: c });
      expect(r.statusCode, JSON.stringify(c)).toBe(400);
    }
    const ok = await wpost(s.w, `/v1/worker/assignments/${s.o.assignmentId}/progress`, { progress: 0.33, checkpoint: cp });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await req(op, 'GET', `/v1/inference/${run.id}`)).json().progress).toMatchObject({ processedImages: 4, fraction: 4 / 6 });
    await wpost(s.w, `/v1/worker/assignments/${s.o.assignmentId}/result`, { status: 'failed', error: 'preempted: owner paused', retryable: true });
    expect((await image(s.w, s.o.assignmentId, 3)).statusCode).toBe(409); // no longer running
    expect((await req(op, 'GET', `/v1/inference/${run.id}/result`)).statusCode).toBe(409);

    // Retry: the next offer carries the checkpoint.
    await h.rt.db.query(`UPDATE job_assignments SET finished_at = now() - interval '2 minutes' WHERE finished_at IS NOT NULL`);
    await engine.tick();
    const retry = [...(await offers(a)).map((o) => ({ w: a, o })), ...(await offers(b)).map((o) => ({ w: b, o }))];
    expect(retry).toHaveLength(1);
    const r = retry[0]!;
    expect(r.w.id).not.toBe(s.w.id); // the worker that failed this batch is excluded
    expect(r.o.checkpoint).toEqual(cp);
    await wpost(r.w, `/v1/worker/assignments/${r.o.assignmentId}/accept`);
    // A lying worker adds a result for another batch: it is dropped from the combined result.
    const out = { ...output([3, 4, 5], 'gpu'), device: 'NVIDIA GeForce RTX 3060 (Dx12)', resumed: 1 };
    out.items.push({ index: 0, label: 5, confidenceBp: 10000, topK: [{ label: 5, confidenceBp: 10000 }] });
    await complete(r.w, r.o.assignmentId, out);

    const done = (await req(op, 'GET', `/v1/inference/${run.id}`)).json();
    expect(done).toMatchObject({ status: 'COMPLETED', resultAvailable: true, progress: { processedImages: 6, fraction: 1 } });
    const res = (await req(op, 'GET', `/v1/inference/${run.id}/result`)).json();
    expect(res.status).toBe('COMPLETED');
    expect(res.items.map((i: { index: number }) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(res.items.map((i: { label: number }) => i.label)).toEqual(PNGS.slice(0, 6).map((p) => p.label));
    expect(res.items[0].name).toBe(PNGS[0]!.name);
    expect(res.summary).toMatchObject({ images: 6, classified: 6, failed: 0, batches: 2, batchesCompleted: 2, accelerators: { cpu: 1, gpu: 1 }, workers: 1 });
    expect(res.batches[1]).toMatchObject({ attempts: 2, accelerator: 'gpu', device: 'NVIDIA GeForce RTX 3060 (Dx12)' });
    const { id: _id, resultSha256, ...body } = res;
    expect(resultSha256).toBe(sha(body));
    expect((await req(other, 'GET', `/v1/inference/${run.id}/result`)).statusCode).toBe(404);
  });

  it('a timed-out batch is retried from its checkpoint; the last timeout ends it with partial results', async () => {
    const id = await dataset(4);
    const run = (await req(op, 'POST', '/v1/inference', { datasetId: id, batchSize: 4, maxAttempts: 2, timeoutSeconds: 10 })).json();
    const workers = [await worker('slow-1'), await worker('slow-2')];
    for (let attempt = 1; attempt <= 2; attempt++) {
      await engine.tick();
      const w = (await h.rt.db.query(`SELECT worker_id FROM jobs WHERE group_id = $1`, [run.id])).rows[0].worker_id === workers[0]!.id
        ? workers[0]!
        : workers[1]!;
      const [o] = await offers(w);
      expect(o, `attempt ${attempt}`).toBeTruthy();
      await wpost(w, `/v1/worker/assignments/${o!.assignmentId}/accept`);
      await wpost(w, `/v1/worker/assignments/${o!.assignmentId}/progress`, { progress: 0.5, checkpoint: { items: predict(attempt === 1 ? [0] : [0, 1]) } });
      await h.rt.db.query(`UPDATE job_assignments SET started_at = now() - interval '11 seconds' WHERE status = 'running'`);
      await heartbeat(h, w, { workloadTypes: TYPES, activeAssignmentIds: [o!.assignmentId] });
      expect((await engine.tick()).timedOut).toBe(1);
      const job = (await h.rt.db.query(`SELECT status, failures FROM jobs WHERE group_id = $1`, [run.id])).rows[0];
      if (attempt === 1) {
        // Re-queued (and possibly already re-placed on the other worker in the same pass).
        expect(job.failures).toBe(1);
        expect(['QUEUED', 'ASSIGNED']).toContain(job.status);
      } else expect(job).toEqual({ status: 'TIMEOUT', failures: 2 });
    }
    const res = (await req(op, 'GET', `/v1/inference/${run.id}/result`)).json();
    expect(res.status).toBe('PARTIAL');
    expect(res.items.map((i: { label?: number; error?: string }) => i.label ?? i.error)).toEqual([
      PNGS[0]!.label,
      PNGS[1]!.label,
      'BATCH_TIMEOUT',
      'BATCH_TIMEOUT',
    ]);
  });

  it('cancel stops every batch and still returns what was done', async () => {
    const id = await dataset(4);
    const run = (await req(op, 'POST', '/v1/inference', { datasetId: id, batchSize: 2 })).json();
    const w = await worker('pc');
    await engine.tick();
    const [o1, o2] = (await offers(w)).sort((x, y) => x.input.images[0]!.index - y.input.images[0]!.index);
    await wpost(w, `/v1/worker/assignments/${o1!.assignmentId}/accept`);
    await complete(w, o1!.assignmentId, output(o1!.input.images.map((i) => i.index)));
    await wpost(w, `/v1/worker/assignments/${o2!.assignmentId}/accept`);
    const stop = new Promise((resolve) => h.rt.bus.onWorker(w.id, resolve));
    expect((await req(other, 'POST', `/v1/inference/${run.id}/cancel`)).statusCode).toBe(404);
    const c = await req(op, 'POST', `/v1/inference/${run.id}/cancel`);
    expect(c.json()).toMatchObject({ status: 'CANCELLED', resultAvailable: true });
    expect(await stop).toMatchObject({ type: 'assignment.cancel', assignmentId: o2!.assignmentId });
    const res = (await req(op, 'GET', `/v1/inference/${run.id}/result`)).json();
    expect(res.summary).toMatchObject({ images: 4, classified: 2 });
    expect(res.items[3].error).toBe('BATCH_CANCELLED');
    expect((await req(op, 'POST', `/v1/inference/${run.id}/cancel`)).statusCode).toBe(409);
  });
});

describe('aggregation', () => {
  it('ignores malformed or foreign items and reports missing ones', () => {
    const input = { images: [0, 1, 2].map((i) => ({ index: i, sha256: 'a'.repeat(64), size: 1 })), topK: 1 };
    const out = {
      items: [
        ...predict([0]),
        { index: 1, label: 3, confidenceBp: 20000, topK: [{ label: 3, confidenceBp: 20000 }] }, // impossible confidence
        { index: 7, label: 1, confidenceBp: 1, topK: [{ label: 1, confidenceBp: 1 }] }, // not in batch
        { index: 2, error: 'DECODE_ERROR' },
      ],
    };
    const { status, result } = combine(
      [{ jobId: 'j', batchIndex: 0, status: 'COMPLETED', input, output: out, checkpoint: null, error: null, workerId: 'w', attempts: 1 }],
      new Map(),
      false,
    );
    expect(status).toBe('COMPLETED');
    expect(result.items.map((i) => i.label ?? i.error)).toEqual([PNGS[0]!.label, 'MISSING_RESULT', 'DECODE_ERROR']);
    expect(result.summary).toMatchObject({ classified: 1, failed: 2 });
  });
});
