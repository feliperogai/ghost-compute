import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, calibrate, createJob, heartbeat, makeUser, registerWorker, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import { collectNetwork } from '../src/observability/collector.js';
import { bucketIndex, HttpMetrics, LATENCY_BUCKETS_MS, mergeBuckets, percentile } from '../src/observability/http-metrics.js';
import { serveDashboard } from '../src/observability/routes.js';

let h: Harness;
let viewer: string;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  viewer = await makeUser(h, 'viewer');
});
afterAll(() => h.close());

const get = (url: string, token = viewer) => h.app.inject({ url, headers: auth(token) });

describe('latency histogram', () => {
  it('buckets, merges and interpolates percentiles', () => {
    expect(bucketIndex(3)).toBe(0);
    expect(bucketIndex(5)).toBe(0);
    expect(bucketIndex(6)).toBe(1);
    expect(bucketIndex(99_999)).toBe(LATENCY_BUCKETS_MS.length);
    const b = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    b[bucketIndex(20)] = 90; // 10..25 ms
    b[bucketIndex(400)] = 10; // 250..500 ms
    expect(percentile(b, 0.5)).toBeGreaterThan(10);
    expect(percentile(b, 0.5)).toBeLessThanOrEqual(25);
    expect(percentile(b, 0.95)).toBeGreaterThan(250);
    expect(percentile(new Array(12).fill(0), 0.5)).toBeNull();
    expect(mergeBuckets([[1, 2], [3, 4]]).slice(0, 2)).toEqual([4, 6]);
  });

  it('records every request, logs 5xx with the request id, and flushes per minute', async () => {
    const app = Fastify();
    const m = new HttpMetrics(h.rt.db);
    m.register(app);
    app.get('/ok', async () => ({ ok: true }));
    app.get('/boom', async () => {
      throw new Error('database exploded');
    });
    app.get('/healthz', async () => 'ok');
    await app.inject('/ok');
    await app.inject('/ok');
    await app.inject('/boom');
    await app.inject('/healthz'); // probes are not traffic
    await app.inject('/nope'); // 404
    await app.close(); // flushes
    const row = (await h.rt.db.query(`SELECT * FROM api_metrics WHERE instance = $1`, [m.instance])).rows[0];
    expect(row).toMatchObject({ requests: 4, errors_4xx: 1, errors_5xx: 1 });
    expect(row.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(4);
    const err = (await h.rt.db.query(`SELECT * FROM api_errors`)).rows[0];
    expect(err).toMatchObject({ method: 'GET', route: '/boom', status: 500, message: 'database exploded' });
    expect(err.request_id).toBeTruthy();
  });

  it('partial minutes flushed twice add up (buckets merged element-wise)', async () => {
    const m = new HttpMetrics(h.rt.db);
    const at = Date.UTC(2026, 0, 1, 12, 0, 10);
    m.record(200, 3, at);
    await m.flush();
    m.record(500, 30, at + 20_000);
    m.record(200, 3, at + 30_000);
    await m.flush();
    const row = (await h.rt.db.query(`SELECT * FROM api_metrics WHERE instance = $1`, [m.instance])).rows[0];
    expect(row).toMatchObject({ requests: 3, errors_5xx: 1 });
    expect(row.buckets[bucketIndex(3)]).toBe(2);
    expect(row.buckets[bucketIndex(30)]).toBe(1);
  });
});

describe('dashboard API', () => {
  it('requires a user token', async () => {
    expect((await h.app.inject('/v1/dashboard/overview')).statusCode).toBe(401);
    expect((await get('/v1/dashboard/overview')).statusCode).toBe(200);
  });

  it('overview, history, workers, worker details and errors reflect the network', async () => {
    const hw = {
      cpu: { model: 'Ryzen 7 5800X', cores: 8, threads: 16, features: [] },
      ramMb: 32768,
      gpus: [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', vramMb: 12282 }],
      os: { name: 'Windows', version: '11' },
    };
    const w = await registerWorker(h, { name: 'rtx-box', hardware: hw, maxConcurrentTasks: 4 });
    const cap = { cpuCores: 8, ramMb: 16384, gpuPercent: 80, vramMb: 12282, diskMb: 1000, maxTemperatureC: 85 };
    await calibrate(h, w, { gpuGflops: 20_000, inferGpu: 8000 });
    await heartbeat(h, w, { capacity: cap, usage: { cpuPercent: 37.5, cpuGhostPercent: 20, ramUsedMb: 9000, temperatureC: 61 } });
    await heartbeat(h, w, { capacity: cap }); // same minute: one sample only
    const off = await registerWorker(h, { name: 'old-laptop' });
    await heartbeat(h, off);
    await h.rt.db.query(`UPDATE workers SET state = 'offline' WHERE id = $1`, [off.id]);

    // Jobs: one completed on the worker, one failed attempt, one queued.
    const engine = createEngine(h.rt);
    const done = await createJob(h, h.adminToken);
    await engine.tick();
    const [a] = (await heartbeat(h, w, { capacity: cap })).json().assignments;
    await h.app.inject({ method: 'POST', url: `/v1/worker/assignments/${a.assignmentId}/accept`, headers: auth(w.token) });
    const out = { checksum: 'x' };
    const sha = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(out)).digest('hex');
    await h.app.inject({ method: 'POST', url: `/v1/worker/assignments/${a.assignmentId}/result`, headers: auth(w.token), payload: { status: 'completed', output: out, outputSha256: sha } });
    const bad = await createJob(h, h.adminToken, { maxAttempts: 1 });
    await engine.tick();
    const [b] = (await heartbeat(h, w, { capacity: cap })).json().assignments;
    await h.app.inject({ method: 'POST', url: `/v1/worker/assignments/${b.assignmentId}/accept`, headers: auth(w.token) });
    await h.app.inject({ method: 'POST', url: `/v1/worker/assignments/${b.assignmentId}/result`, headers: auth(w.token), payload: { status: 'failed', error: 'sandbox crashed (exit 3)', retryable: false } });
    await createJob(h, h.adminToken, { requirements: { os: 'linux' } });
    await engine.tick();
    await h.rt.db.query(`INSERT INTO api_errors (method, route, status, request_id, message) VALUES ('GET', '/v1/x', 500, 'req-1', 'boom')`);

    const o = (await get('/v1/dashboard/overview')).json();
    expect(o.network).toMatchObject({
      workersOnline: 1,
      workersOffline: 1,
      cpu: { offeredCores: 8, threads: 16 },
      gpu: { shared: 1, installed: 1 },
      vram: { offeredMb: 12282, installedMb: 12282 },
      ram: { offeredMb: 16384, installedMb: 32768 },
    });
    expect(o.jobs).toMatchObject({ queued: 1, completed: 1, failed: 1, running: 0 });
    expect(o.jobs.pendingReasons[0].reason).toMatch(/OS_MISMATCH/);
    expect(o.system.attemptsLastHour).toMatchObject({ completed: 1, failed: 1, failureRate: 0.5 });
    expect(o.recentErrors.map((e: { kind: string }) => e.kind).sort()).toEqual(['api', 'attempt']);

    await collectNetwork(h.rt);
    const hist = (await get('/v1/dashboard/history?range=1h')).json();
    expect(hist.stepSeconds).toBe(60);
    expect(hist.network.at(-1)).toMatchObject({ workersOnline: 1, workersOffline: 1, cpuCores: 8, gpus: 1, jobsQueued: 1 });
    expect((await get('/v1/dashboard/history?range=1y')).statusCode).toBe(400);

    const list = (await get('/v1/dashboard/workers')).json().items;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['rtx-box', 'old-laptop']);
    expect(list[0]).toMatchObject({
      online: true,
      hardware: { cpu: 'Ryzen 7 5800X', threads: 16, gpus: [{ name: 'NVIDIA GeForce RTX 4070' }] },
      usage: { cpuPercent: 10 },
      performance: { verified: true },
      last24h: { completed: 1, failed: 1 },
    });
    expect(list[0].uptimeS).toBeGreaterThanOrEqual(0);
    expect(list[1]).toMatchObject({ online: false, uptimeS: null });

    const d = (await get(`/v1/dashboard/workers/${w.id}?range=1h`)).json();
    expect(d.worker.name).toBe('rtx-box');
    expect(d.history.points).toHaveLength(1);
    // One sample per minute: the first heartbeat of the minute (during calibration) is kept.
    expect(d.history.points[0]).toMatchObject({ cpuPercent: 10, temperatureC: 50, sharingFraction: 1 });
    expect(d.assignments.map((x: { status: string }) => x.status)).toEqual(['failed', 'completed']);
    expect(d.assignments[0].error).toBe('sandbox crashed (exit 3)');
    expect(d.decisions[0].summary).toMatch(/foi escolhido porque/);
    expect(d.profile.gpu.name).toBe('NVIDIA GeForce RTX 4070');
    expect(d.calibrations[0].status).toBe('COMPLETED');
    expect(d.events.length).toBeGreaterThan(0);
    expect((await get('/v1/dashboard/workers/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);

    const errs = (await get(`/v1/dashboard/errors?workerId=${w.id}`)).json().items;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ kind: 'attempt', workerName: 'rtx-box', code: 'failed', message: 'sandbox crashed (exit 3)' });
    expect((await get('/v1/dashboard/errors?kind=api')).json().items[0]).toMatchObject({ source: 'GET /v1/x', ref: 'req-1' });
    void done;
    void bad;
  });
});

describe('static dashboard', () => {
  it('serves the build, falls back to index.html, never outside the directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dash-'));
    writeFileSync(path.join(dir, 'index.html'), '<html>ghost</html>');
    writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    const app = Fastify();
    await serveDashboard(app, dir);
    expect((await app.inject('/dashboard/app.js')).headers['content-type']).toMatch(/javascript/);
    const spa = await app.inject('/dashboard/workers/123');
    expect(spa.body).toBe('<html>ghost</html>');
    expect(spa.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    for (const evil of ['/dashboard/../../../../etc/passwd', '/dashboard/%2e%2e/%2e%2e/etc/passwd', '/dashboard/..%2f..%2fpackage.json']) {
      const r = await app.inject(evil);
      expect(r.body).not.toContain('root:');
      expect(r.body).not.toContain('"name"');
    }
    expect((await app.inject('/dashboard')).statusCode).toBe(302);
    await app.close();
  });
});
