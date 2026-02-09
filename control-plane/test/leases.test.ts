import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createJob,
  heartbeat,
  makeUser,
  registerWorker,
  reset,
  setup,
  type Harness,
  type TestWorker,
} from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { LeaseService } from '../src/modules/leases/service.js';
import { WorkerService } from '../src/modules/workers/service.js';

let h: Harness;
let op: string;
let w: TestWorker;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
  w = await registerWorker(h);
  await heartbeat(h, w);
});
afterAll(() => h.close());

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const post = (worker: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(worker.token), ...(payload ? { payload } : {}) });
const claim = async (worker: TestWorker, max = 1) => (await post(worker, '/v1/worker/leases/claim', { max })).json().offers;
const job = (id: string) => h.app.inject({ url: `/v1/jobs/${id}`, headers: auth(op) }).then((r) => r.json());
const succeed = (worker: TestWorker, leaseId: string, output: unknown) =>
  post(worker, `/v1/worker/leases/${leaseId}/result`, { status: 'succeeded', output, outputSha256: sha(output) });

describe('happy path', () => {
  it('offer -> accept -> progress -> result completes the job', async () => {
    const j = await createJob(h, op, { inputs: [{ n: 1 }] });
    const [offer] = await claim(w);
    expect(offer).toMatchObject({ jobId: j.id, taskIndex: 0, input: { n: 1 }, module: { name: 'monte-carlo-pi' } });
    expect((await job(j.id)).status).toBe('running');

    expect((await post(w, `/v1/worker/leases/${offer.leaseId}/accept`)).statusCode).toBe(200);
    // Accept is idempotent.
    expect((await post(w, `/v1/worker/leases/${offer.leaseId}/accept`)).statusCode).toBe(200);

    const p = await post(w, `/v1/worker/leases/${offer.leaseId}/progress`, { progress: 0.5, stage: 'sampling' });
    expect(p.statusCode).toBe(200);
    expect((await job(j.id)).progress).toBeCloseTo(0.5);

    const r = await succeed(w, offer.leaseId, { pi: 3.14 });
    expect(r.json()).toMatchObject({ status: 'succeeded', taskStatus: 'succeeded' });

    const done = await job(j.id);
    expect(done).toMatchObject({ status: 'completed', succeededTasks: 1, progress: 1 });
    expect(done.finishedAt).toBeTruthy();

    const tasks = (await h.app.inject({ url: `/v1/jobs/${j.id}/tasks`, headers: auth(op) })).json();
    expect(tasks.items[0]).toMatchObject({ output: { pi: 3.14 }, outputSha256: sha({ pi: 3.14 }) });

    const events = (await h.app.inject({ url: `/v1/jobs/${j.id}/events`, headers: auth(op) })).json();
    expect(events.items.map((e: { type: string }) => e.type)).toEqual([
      'job.created',
      'lease.offered',
      'lease.accepted',
      'task.stage',
      'lease.succeeded',
    ]);

    // Result after completion is rejected.
    expect((await succeed(w, offer.leaseId, { pi: 3.14 })).statusCode).toBe(409);
  });

  it('respects worker capacity and priority', async () => {
    const low = await createJob(h, op, { priority: 10, inputs: [{}, {}] });
    const high = await createJob(h, op, { priority: 90, inputs: [{}] });
    const offers = await claim(w, 5);
    expect(offers).toHaveLength(1);
    expect(offers[0].jobId).toBe(high.id);
    expect(await claim(w)).toEqual([]);
    expect(low.id).toBeTruthy();
  });

  it('heartbeat returns pending offers', async () => {
    await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    const hb = (await heartbeat(h, w)).json();
    expect(hb.offers.map((o: { leaseId: string }) => o.leaseId)).toEqual([offer.leaseId]);
  });
});

describe('worker stats', () => {
  it('counts outcomes and credits only successful compute time', async () => {
    const j = await createJob(h, op, { name: 'render', inputs: [{}, {}], maxRetries: 0 });
    const [a] = await claim(w);
    await post(w, `/v1/worker/leases/${a.leaseId}/accept`);
    await h.rt.db.query(`UPDATE leases SET accepted_at = now() - interval '90 seconds' WHERE id = $1`, [a.leaseId]);
    await succeed(w, a.leaseId, { ok: true });
    const [c] = await claim(w);
    await post(w, `/v1/worker/leases/${c.leaseId}/accept`);
    await post(w, `/v1/worker/leases/${c.leaseId}/result`, { status: 'failed', error: 'x' });

    const res = await h.app.inject({ url: '/v1/worker/me/stats?recent=5', headers: auth(w.token) });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.tasks).toEqual({ succeeded: 1, failed: 1, preempted: 0, active: 0 });
    expect(s.credits).toBeGreaterThanOrEqual(1.5);
    expect(s.credits).toBeLessThan(1.6);
    expect(s.recent).toHaveLength(2);
    expect(s.recent[0]).toMatchObject({ jobId: j.id, jobName: 'render', status: 'failed', module: { name: 'monte-carlo-pi' } });

    // Users cannot call worker endpoints; other workers see only their own stats.
    expect((await h.app.inject({ url: '/v1/worker/me/stats', headers: auth(op) })).statusCode).toBe(401);
    const other = await registerWorker(h, { name: 'other' });
    const o = await h.app.inject({ url: '/v1/worker/me/stats', headers: auth(other.token) });
    expect(o.json()).toMatchObject({ tasks: { succeeded: 0 }, credits: 0, recent: [] });
  });
});

describe('validation & ownership', () => {
  it('rejects progress before accept and bad hashes', async () => {
    await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    const early = await post(w, `/v1/worker/leases/${offer.leaseId}/progress`, { progress: 0.1 });
    expect(early.json().error.code).toBe('LEASE_NOT_ACTIVE');
    await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);
    const bad = await post(w, `/v1/worker/leases/${offer.leaseId}/result`, {
      status: 'succeeded',
      output: { x: 1 },
      outputSha256: 'a'.repeat(64),
    });
    expect(bad.statusCode).toBe(400);
    const oob = await post(w, `/v1/worker/leases/${offer.leaseId}/progress`, { progress: 2 });
    expect(oob.statusCode).toBe(400);
  });

  it("hides other workers' leases", async () => {
    const other = await registerWorker(h, { name: 'other' });
    await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    const res = await post(other, `/v1/worker/leases/${offer.leaseId}/accept`);
    expect(res.statusCode).toBe(404);
  });

  it('does not offer to paused or offline workers', async () => {
    await createJob(h, op, { inputs: [{}] });
    await heartbeat(h, w, { state: 'paused' });
    expect(await claim(w)).toEqual([]);
    await heartbeat(h, w, { state: 'available' });
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    expect(await claim(w)).toEqual([]);
  });

  it('matches hardware requirements', async () => {
    const small = await registerWorker(h, {
      name: 'small',
      hardware: { cpu: { model: 'x', cores: 2, threads: 2 }, ramMb: 2048, os: { name: 'Windows', version: '10' } },
    });
    await heartbeat(h, small);
    await createJob(h, op, { inputs: [{}], requirements: { minRamMb: 8000, cpuFeatures: ['AVX2'] } });
    expect(await claim(small)).toEqual([]);
    expect(await h.rt.queue.size()).toBe(1); // skipped, not lost
    expect(await claim(w)).toHaveLength(1);
  });
});

describe('failures & retries', () => {
  it('retries failed tasks up to maxRetries then fails the job', async () => {
    const j = await createJob(h, op, { inputs: [{}], maxRetries: 1 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [offer] = await claim(w);
      expect(offer).toBeDefined();
      await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);
      const r = await post(w, `/v1/worker/leases/${offer.leaseId}/result`, { status: 'failed', error: 'boom' });
      expect(r.json().taskStatus).toBe(attempt === 1 ? 'pending' : 'failed');
    }
    expect(await job(j.id)).toMatchObject({ status: 'failed', failedTasks: 1 });
    expect(await h.rt.queue.size()).toBe(0);
  });

  it('preemption and rejection requeue without consuming attempts', async () => {
    await createJob(h, op, { inputs: [{}], maxRetries: 0 });
    let [offer] = await claim(w);
    await post(w, `/v1/worker/leases/${offer.leaseId}/reject`, { reason: 'user active' });
    [offer] = await claim(w);
    await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);
    const r = await post(w, `/v1/worker/leases/${offer.leaseId}/result`, { status: 'preempted', reason: 'cpu limit' });
    expect(r.json().taskStatus).toBe('pending');
    const { rows } = await h.rt.db.query(`SELECT attempts, status FROM tasks`);
    expect(rows[0]).toEqual({ attempts: 0, status: 'pending' });
  });

  it('expires stale leases and requeues', async () => {
    await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    const leases = new LeaseService(h.rt);
    expect(await leases.expireDue()).toBe(0);
    await h.rt.db.query(`UPDATE leases SET expires_at = now() - interval '1 second'`);
    expect(await leases.expireDue()).toBe(1);
    const { rows } = await h.rt.db.query(`SELECT status, attempts FROM tasks`);
    expect(rows[0]).toEqual({ status: 'pending', attempts: 1 });
    expect(await h.rt.queue.size()).toBe(1);
    expect((await post(w, `/v1/worker/leases/${offer.leaseId}/accept`)).statusCode).toBe(409);
  });

  it('heartbeat keeps running leases alive', async () => {
    await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);
    await h.rt.db.query(`UPDATE leases SET expires_at = now() + interval '1 second'`);
    const hb = await heartbeat(h, w, { state: 'running', activeLeaseIds: [offer.leaseId] });
    expect(hb.json().cancelLeaseIds).toEqual([]);
    const { rows } = await h.rt.db.query(`SELECT expires_at > now() + interval '30 seconds' AS ok FROM leases`);
    expect(rows[0].ok).toBe(true);
  });

  it('offline worker releases its leases', async () => {
    await createJob(h, op, { inputs: [{}] });
    await claim(w);
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    await new WorkerService(h.rt).detectOffline();
    const { rows } = await h.rt.db.query(`SELECT l.status AS l, t.status AS t FROM leases l JOIN tasks t ON t.id = l.task_id`);
    expect(rows[0]).toEqual({ l: 'expired', t: 'pending' });
  });
});

describe('cancellation & revocation mid-run', () => {
  it('job cancel notifies the worker and blocks its result', async () => {
    const j = await createJob(h, op, { inputs: [{}] });
    const [offer] = await claim(w);
    await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);

    const got = new Promise((resolve) => h.rt.bus.onWorker(w.id, resolve));
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${j.id}/cancel`, headers: auth(op) });
    expect(await got).toEqual({ type: 'lease.cancel', leaseId: offer.leaseId, reason: 'job cancelled' });

    expect((await succeed(w, offer.leaseId, 1)).statusCode).toBe(409);
    const hb = await heartbeat(h, w, { state: 'running', activeLeaseIds: [offer.leaseId] });
    expect(hb.json().cancelLeaseIds).toEqual([offer.leaseId]);
  });

  it('revoking a worker requeues its tasks without penalty', async () => {
    await createJob(h, op, { inputs: [{}], maxRetries: 0 });
    const [offer] = await claim(w);
    await post(w, `/v1/worker/leases/${offer.leaseId}/accept`);
    await h.app.inject({
      method: 'POST',
      url: `/v1/workers/${w.id}/revoke`,
      headers: auth(h.adminToken),
      payload: { reason: 'test' },
    });
    const { rows } = await h.rt.db.query(`SELECT status, attempts FROM tasks`);
    expect(rows[0]).toEqual({ status: 'pending', attempts: 0 });

    const w2 = await registerWorker(h, { name: 'w2' });
    await heartbeat(h, w2);
    expect(await claim(w2)).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('never double-leases a task under concurrent claims', async () => {
    await createJob(h, op, { inputs: Array.from({ length: 20 }, (_, i) => ({ i })) });
    const workers: TestWorker[] = [];
    for (let i = 0; i < 5; i++) {
      const x = await registerWorker(h, { name: `c${i}`, maxConcurrentTasks: 4 });
      await heartbeat(h, x);
      workers.push(x);
    }
    const results = await Promise.all(workers.flatMap((x) => [claim(x, 4), claim(x, 4)]));
    const taskIds = results.flat().map((o: { taskId: string }) => o.taskId);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(taskIds.length).toBe(20);
    const { rows } = await h.rt.db.query(
      `SELECT worker_id, count(*)::int AS n FROM leases WHERE status = 'offered' GROUP BY worker_id`,
    );
    for (const r of rows) expect(r.n).toBeLessThanOrEqual(4);
  });
});
