import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPACITY,
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
import { createEngine } from '../src/jobs/runner.js';
import { JobLifecycle } from '../src/jobs/lifecycle.js';
import type { SchedulerEngine } from '../src/scheduler/index.js';

let h: Harness;
let op: string;
let engine: SchedulerEngine;
beforeAll(async () => {
  h = await setup({ ASSIGNMENT_STALE_SECONDS: '10' });
  engine = createEngine(h.rt);
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
});
afterAll(() => h.close());

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const post = (w: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(w.token), ...(payload ? { payload } : {}) });
const getJob = (id: string) => h.app.inject({ url: `/v1/jobs/${id}`, headers: auth(op) }).then((r) => r.json());
const assignments = async (w: TestWorker) => (await heartbeat(h, w)).json().assignments as { assignmentId: string; jobId: string }[];

async function online(name: string, over: object = {}) {
  const w = await registerWorker(h, { name, maxConcurrentTasks: 4 });
  await heartbeat(h, w, over);
  return w;
}

describe('job API', () => {
  it('creates a job with every field and defaults', async () => {
    const j = await createJob(h, op, {
      requirements: { os: 'windows', cpuFeatures: ['avx2'] },
      resources: { cpuCores: 2, ramMb: 2048 },
      priority: 80,
      timeout: 120,
    });
    expect(j).toMatchObject({
      type: 'benchmark',
      status: 'QUEUED',
      priority: 80,
      timeout: 120,
      maxAttempts: 3,
      requirements: { os: 'windows', cpuFeatures: ['avx2'] },
      resources: { cpuCores: 2, ramMb: 2048, gpu: false, vramMb: 0, diskMb: 0 },
      input: { kind: 'primes', size: 1000, iterations: 1 },
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      assignments: [],
    });
    expect(j.owner.email).toBe('operator@ghost.test');
    expect(j.createdAt).toBeTruthy();
    expect(await h.rt.queue.size()).toBe(1);
  });

  it.each([
    // Unregistered types: nothing but registered, sandboxed workloads exist.
    [{ type: 'shell', input: { cmd: 'whoami' } }],
    [{ type: 'powershell', input: 'Get-ChildItem C:\\' }],
    [{ type: 'script', input: { lang: 'python', code: 'import os; os.system("id")' } }],
    [{ type: 'exe', input: { url: 'http://evil/payload.exe' } }],
    [{ type: 'wasm', input: { module: 'AGFzbQEAAAA=' } }],
    [{ type: 'gpu-test' }],
    // Registered type, smuggled or out-of-range parameters.
    [{ input: { kind: 'hash', iterations: 1, command: 'calc.exe' } }],
    [{ input: { kind: 'hash', iterations: 1, path: 'C:\\Users' } }],
    [{ input: { kind: 'hash', iterations: 1, module: 'AGFzbQEAAAA=' } }],
    [{ input: { kind: 'exec', iterations: 1 } }],
    [{ input: { kind: 'hash', iterations: 1e12 } }],
    [{ input: { kind: 'matmul', size: 100000, iterations: 1 } }],
    [{ input: 'benchmark --shell' }],
    // Top-level smuggling and resource abuse.
    [{ command: 'rm -rf /' }],
    [{ executable: 'TVqQAAMAAAAEAAAA' }],
    [{ resources: { gpu: true } }],
    [{ resources: { cpuCores: 0 } }],
    [{ requirements: { gpuVendor: 'Voodoo' } }],
    [{ timeout: 5 }],
  ])('rejects invalid job %j', async (bad) => {
    await expect(createJob(h, op, bad)).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('lists history with filters; only owner or admin can cancel', async () => {
    const other = await makeUser(h, 'operator', 'other@ghost.test');
    const mine = await createJob(h, op);
    await createJob(h, other);
    const list = (await h.app.inject({ url: '/v1/jobs?owner=me', headers: auth(op) })).json();
    expect(list.items.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    expect(list.items[0].input).toBeUndefined();

    const denied = await h.app.inject({ method: 'POST', url: `/v1/jobs/${mine.id}/cancel`, headers: auth(other) });
    expect(denied.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: `/v1/jobs/${mine.id}/cancel`, headers: auth(h.adminToken), payload: { reason: 'admin' } });
    expect(ok.json()).toMatchObject({ status: 'CANCELLED', error: { code: 'CANCELLED', message: 'admin' } });
    expect((await h.app.inject({ url: '/v1/jobs?status=CANCELLED', headers: auth(op) })).json().items).toHaveLength(1);
    expect((await h.app.inject({ url: '/v1/workload-types', headers: auth(op) })).json().items.map((t: { id: string }) => t.id)).toContain('benchmark');
  });
});

describe('scheduling', () => {
  it('assigns → runs → completes, recording result and timestamps', async () => {
    const w = await online('pc');
    const j = await createJob(h, op);
    expect((await engine.tick()).assigned).toBe(1);

    const assigned = await getJob(j.id);
    expect(assigned).toMatchObject({ status: 'ASSIGNED', workerId: w.id });
    expect(assigned.assignments[0]).toMatchObject({ attempt: 1, status: 'assigned', strategy: 'score' });
    expect(assigned.assignments[0].scoreDetail.components).toHaveProperty('current_load');
    // Every decision is explained.
    expect(assigned.placementReason).toMatch(/^Worker pc \(.{8}\) foi escolhido porque era o único worker elegível\./);
    const decisions = (await h.app.inject({ url: `/v1/jobs/${j.id}/decisions`, headers: auth(op) })).json().items;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ workerId: w.id, strategy: 'score', summary: assigned.placementReason });
    expect(decisions[0].explanation.chosen.terms.performance).toMatchObject({ weight: 0.3 });

    const [a] = await assignments(w);
    expect(a).toMatchObject({ jobId: j.id, name: 'primes', type: 'benchmark', input: { kind: 'primes', size: 1000 }, timeoutSeconds: 3600 });
    await post(w, `/v1/worker/assignments/${a!.assignmentId}/accept`);
    expect((await getJob(j.id)).status).toBe('RUNNING');
    await post(w, `/v1/worker/assignments/${a!.assignmentId}/progress`, { progress: 0.5, stage: 'sampling' });
    expect(await getJob(j.id)).toMatchObject({ progress: 0.5, stage: 'sampling' });

    const bad = await post(w, `/v1/worker/assignments/${a!.assignmentId}/result`, { status: 'completed', output: 1, outputSha256: 'a'.repeat(64) });
    expect(bad.statusCode).toBe(400);
    await post(w, `/v1/worker/assignments/${a!.assignmentId}/result`, { status: 'completed', output: { pi: 3.14 }, outputSha256: sha({ pi: 3.14 }) });

    const done = await getJob(j.id);
    expect(done).toMatchObject({ status: 'COMPLETED', output: { pi: 3.14 }, progress: 1, error: null });
    expect(done.startedAt && done.finishedAt).toBeTruthy();
    const events = (await h.app.inject({ url: `/v1/jobs/${j.id}/events`, headers: auth(op) })).json();
    expect(events.items.map((e: { type: string }) => e.type)).toEqual(['job.created', 'job.assigned', 'job.started', 'job.stage', 'job.completed']);
  });

  it('matches requirements and workload type; explains why a job waits', async () => {
    await online('no-types', { workloadTypes: [] });
    const j = await createJob(h, op);
    const bigJob = await createJob(h, op, { resources: { ramMb: 64_000 } });
    await engine.tick();
    expect((await getJob(j.id)).pendingReason).toBe('no eligible worker (1× TYPE_UNSUPPORTED)');
    const w = await online('runner');
    await engine.tick();
    expect(await getJob(j.id)).toMatchObject({ status: 'ASSIGNED', workerId: w.id, pendingReason: null });
    expect((await getJob(bigJob.id)).pendingReason).toMatch(/INSUFFICIENT_RAM/);
  });

  it('selects the better worker: cooler, less loaded', async () => {
    await online('hot', { usage: { cpuPercent: 60, ramUsedMb: 4000, temperatureC: 79 } });
    const cool = await online('cool', { usage: { cpuPercent: 5, ramUsedMb: 4000, temperatureC: 45 } });
    const j = await createJob(h, op);
    await engine.tick();
    expect((await getJob(j.id)).workerId).toBe(cool.id);
  });

  it('does not over-commit a worker and respects priority', async () => {
    await online('pc'); // 4 cores offered
    const low = await createJob(h, op, { priority: 10, resources: { cpuCores: 3 } });
    const high = await createJob(h, op, { priority: 90, resources: { cpuCores: 3 } });
    await engine.tick();
    expect((await getJob(high.id)).status).toBe('ASSIGNED');
    expect((await getJob(low.id))).toMatchObject({ status: 'QUEUED', pendingReason: 'no eligible worker (1× INSUFFICIENT_CPU)' });
  });

  it('paused or offline workers get nothing', async () => {
    await online('paused', { state: 'paused' });
    const j = await createJob(h, op);
    await engine.tick();
    expect((await getJob(j.id)).pendingReason).toBe('no eligible worker (1× NOT_ACCEPTING)');
  });
});

describe('failures and re-routing', () => {
  it('rejection re-routes to another worker without counting a failure', async () => {
    const a = await online('a');
    const b = await online('b');
    const j = await createJob(h, op, { maxAttempts: 1 });
    await engine.tick();
    const first = (await getJob(j.id)).workerId;
    const w1 = first === a.id ? a : b;
    const w2 = first === a.id ? b : a;
    const [as] = await assignments(w1);
    await post(w1, `/v1/worker/assignments/${as!.assignmentId}/reject`, { reason: 'owner busy' });
    expect(await getJob(j.id)).toMatchObject({ status: 'QUEUED', failures: 0 });
    await engine.tick();
    expect((await getJob(j.id)).workerId).toBe(w2.id);
  });

  it('retryable failure goes elsewhere; non-retryable fails the job', async () => {
    const a = await online('a');
    const b = await online('b');
    const j = await createJob(h, op);
    await engine.tick();
    const firstId = (await getJob(j.id)).workerId;
    const first = firstId === a.id ? a : b;
    let [as] = await assignments(first);
    await post(first, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    await post(first, `/v1/worker/assignments/${as!.assignmentId}/result`, { status: 'failed', error: 'out of memory', retryable: true });
    expect(await getJob(j.id)).toMatchObject({ status: 'QUEUED', failures: 1 });
    await engine.tick();
    const second = (await getJob(j.id)).workerId === a.id ? a : b;
    expect(second.id).not.toBe(first.id); // failed worker excluded for this job
    [as] = await assignments(second);
    await post(second, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    await post(second, `/v1/worker/assignments/${as!.assignmentId}/result`, { status: 'failed', error: 'invalid input', retryable: false });
    expect(await getJob(j.id)).toMatchObject({ status: 'FAILED', error: { code: 'JOB_FAILED', message: 'invalid input' } });
    expect((await getJob(j.id)).assignments.map((x: { status: string }) => x.status)).toEqual(['failed', 'failed']);
  });

  it('unaccepted assignment expires and is re-routed; max attempts ends in FAILED', async () => {
    await online('a');
    const j = await createJob(h, op, { maxAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The excluded-worker cooldown would block the only worker; clear it to keep the test short.
      await h.rt.db.query(`UPDATE job_assignments SET finished_at = now() - interval '2 minutes' WHERE finished_at IS NOT NULL`);
      await engine.tick();
      expect((await getJob(j.id)).status).toBe('ASSIGNED');
      await h.rt.db.query(`UPDATE job_assignments SET accept_deadline = now() - interval '1 second' WHERE status = 'assigned'`);
      const r = await engine.tick();
      expect(r.expired).toBe(1);
    }
    expect(await getJob(j.id)).toMatchObject({ status: 'FAILED', failures: 2, error: { code: 'MAX_ATTEMPTS' } });
  });

  it('a running job the worker stops reporting is reclaimed; heartbeats keep it alive', async () => {
    const w = await online('a');
    const j = await createJob(h, op);
    await engine.tick();
    const [as] = await assignments(w);
    await post(w, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    await h.rt.db.query(`UPDATE job_assignments SET last_seen_at = now() - interval '5 seconds'`);
    await heartbeat(h, w, { activeAssignmentIds: [as!.assignmentId] });
    expect((await engine.tick()).stale).toBe(0);
    await h.rt.db.query(`UPDATE job_assignments SET last_seen_at = now() - interval '1 minute'`);
    expect((await engine.tick()).stale).toBe(1);
    expect(await getJob(j.id)).toMatchObject({ status: 'QUEUED', failures: 1 });
  });

  it('timeout is terminal and tells the worker to stop', async () => {
    const w = await online('a');
    const j = await createJob(h, op, { timeout: 10 });
    await engine.tick();
    const [as] = await assignments(w);
    await post(w, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    const got = new Promise((resolve) => h.rt.bus.onWorker(w.id, resolve));
    await h.rt.db.query(`UPDATE job_assignments SET started_at = now() - interval '11 seconds'`);
    await heartbeat(h, w, { activeAssignmentIds: [as!.assignmentId] });
    expect((await engine.tick()).timedOut).toBe(1);
    expect(await got).toEqual({ type: 'assignment.cancel', assignmentId: as!.assignmentId, reason: 'timeout' });
    expect(await getJob(j.id)).toMatchObject({ status: 'TIMEOUT', error: { code: 'TIMEOUT' } });
    // A late result is refused.
    const late = await post(w, `/v1/worker/assignments/${as!.assignmentId}/result`, { status: 'completed', output: 1, outputSha256: sha(1) });
    expect(late.json().error.code).toBe('ASSIGNMENT_NOT_ACTIVE');
  });

  it('worker going offline re-routes its jobs', async () => {
    const a = await online('a');
    const j = await createJob(h, op);
    await engine.tick();
    const [as] = await assignments(a);
    await post(a, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    const b = await online('b');
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
    const r = await engine.tick();
    expect(r.offline).toBe(1);
    expect(r.assigned).toBe(1);
    expect(await getJob(j.id)).toMatchObject({ status: 'ASSIGNED', workerId: b.id, failures: 1 });
  });

  it('revoking a worker re-routes and cancels on the worker', async () => {
    const a = await online('a');
    const j = await createJob(h, op);
    await engine.tick();
    await h.app.inject({ method: 'POST', url: `/v1/workers/${a.id}/revoke`, headers: auth(h.adminToken), payload: { reason: 'x' } });
    expect((await getJob(j.id)).status).toBe('QUEUED');
    expect((await getJob(j.id)).assignments[0].status).toBe('lost');
  });

  it('cancel while running notifies the worker and refuses its result', async () => {
    const w = await online('a');
    const j = await createJob(h, op);
    await engine.tick();
    const [as] = await assignments(w);
    await post(w, `/v1/worker/assignments/${as!.assignmentId}/accept`);
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${j.id}/cancel`, headers: auth(op) });
    const hb = (await heartbeat(h, w, { activeAssignmentIds: [as!.assignmentId] })).json();
    expect(hb.cancelAssignmentIds).toEqual([as!.assignmentId]);
    const late = await post(w, `/v1/worker/assignments/${as!.assignmentId}/result`, { status: 'completed', output: 1, outputSha256: sha(1) });
    expect(late.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'POST', url: `/v1/jobs/${j.id}/cancel`, headers: auth(op) })).statusCode).toBe(409);
  });

  it('workers only see and act on their own assignments', async () => {
    const a = await online('a');
    const b = await online('b', { usage: { cpuPercent: 90, ramUsedMb: 1, temperatureC: 80 } }); // a wins
    await createJob(h, op);
    await engine.tick();
    const [as] = await assignments(a);
    expect(await assignments(b)).toEqual([]);
    expect((await post(b, `/v1/worker/assignments/${as!.assignmentId}/accept`)).statusCode).toBe(404);
  });
});

describe('concurrency', () => {
  it('the database refuses a placement that would over-commit, even from a stale decision', async () => {
    const w = await online('pc'); // 4 cores, 8192 MB, 4 slots
    const lc = new JobLifecycle(h.rt);
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await createJob(h, op, { resources: { cpuCores: 2 } }));
    const place = (id: string) =>
      lc.assign({ jobId: id, workerId: w.id, score: { total: 1, components: {} } }, 'test', {
        cpuCores: 2, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0,
      });
    expect(await place(jobs[0].id)).not.toBeNull();
    expect(await place(jobs[1].id)).not.toBeNull();
    expect(await place(jobs[2].id)).toBeNull(); // would need 6 of 4 cores
    expect((await getJob(jobs[2].id)).status).toBe('QUEUED');
    // Same job twice is refused too.
    expect(await place(jobs[0].id)).toBeNull();
  });

  it('simultaneous placements on one worker never exceed its capacity', async () => {
    const w = await online('pc'); // 4 cores
    const lc = new JobLifecycle(h.rt);
    for (let round = 0; round < 15; round++) {
      await h.rt.db.query(`UPDATE job_assignments SET status = 'completed', finished_at = now() WHERE status = 'assigned'`);
      const jobs = [];
      for (let i = 0; i < 4; i++) jobs.push(await createJob(h, op, { resources: { cpuCores: 2 } }));
      const results = await Promise.all(
        jobs.map((j) =>
          lc.assign({ jobId: j.id, workerId: w.id, score: { total: 1, components: {} } }, 'test', {
            cpuCores: 2, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0,
          }),
        ),
      );
      expect(results.filter(Boolean).length).toBeLessThanOrEqual(2);
    }
  });

  it('two engines ticking together never double-assign or over-commit', async () => {
    for (let i = 0; i < 3; i++) await online(`w${i}`);
    // 4 cores offered and 4 slots per worker: 2-core jobs make CPU the binding limit (2 per worker).
    for (let i = 0; i < 20; i++) await createJob(h, op, { resources: { cpuCores: 2 } });
    // Separate engines = separate in-memory snapshots, like two schedulers during a leader hand-over.
    const engines = [engine, createEngine(h.rt), createEngine(h.rt)];
    await Promise.all(engines.map((e) => e.tick()));
    const { rows } = await h.rt.db.query(
      `SELECT worker_id, count(*)::int n, sum((reserved->>'cpuCores')::float) cpu FROM job_assignments
        WHERE status IN ('assigned', 'running') GROUP BY worker_id`,
    );
    for (const r of rows) expect(r.cpu).toBeLessThanOrEqual(4);
    const dup = await h.rt.db.query(`SELECT job_id FROM job_assignments GROUP BY job_id HAVING count(*) > 1`);
    expect(dup.rows).toEqual([]);
    const total = rows.reduce((s, r) => s + r.n, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(6);
  });
});
