import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import type { Role } from '../src/auth/plugin.js';

export interface Harness {
  rt: Runtime;
  app: FastifyInstance;
  adminToken: string;
  close(): Promise<void>;
}

export async function setup(overrides: Record<string, string> = {}): Promise<Harness> {
  Object.assign(process.env, overrides);
  const rt = await createRuntime();
  await migrate(rt.db);
  await reset(rt);
  const app = await buildApp(rt);
  await app.ready();
  const { token } = await createUserWithToken(rt, { email: 'admin@ghost.test', role: 'admin', tokenName: 't' }, null);
  return {
    rt,
    app,
    adminToken: token,
    async close() {
      await app.close();
      await rt.close();
    },
  };
}

export async function reset(rt: Runtime) {
  await rt.db.query(
    `TRUNCATE audit_log, worker_metrics, network_metrics, api_metrics, api_errors, scheduler_decisions, worker_performance, worker_calibrations, job_events, job_assignments, jobs, job_groups, dataset_images, datasets, enrollment_tokens,
              workers, api_tokens, users CASCADE`,
  );
  await rt.redis.flushdb();
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export async function makeUser(h: Harness, role: Role, email = `${role}@ghost.test`): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: auth(h.adminToken),
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().token;
}

export const HW = {
  cpu: { model: 'Test CPU', cores: 8, threads: 16, features: ['avx2'] },
  ramMb: 16384,
  gpus: [],
  os: { name: 'Windows', version: '11 23H2' },
};

export async function enrollmentToken(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/admin/enrollment-tokens',
    headers: auth(h.adminToken),
    payload: {},
  });
  return res.json().token;
}

export interface TestWorker {
  id: string;
  secret: string;
  token: string;
}

export async function registerWorker(
  h: Harness,
  opts: { name?: string; hardware?: object; maxConcurrentTasks?: number } = {},
): Promise<TestWorker> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/workers/register',
    payload: {
      enrollmentToken: await enrollmentToken(h),
      name: opts.name ?? 'pc-1',
      hardware: opts.hardware ?? HW,
      maxConcurrentTasks: opts.maxConcurrentTasks ?? 1,
    },
  });
  if (reg.statusCode !== 201) throw new Error(reg.body);
  const { workerId, workerSecret } = reg.json();
  const a = await h.app.inject({
    method: 'POST',
    url: '/v1/workers/auth',
    payload: { workerId, workerSecret },
  });
  return { id: workerId, secret: workerSecret, token: a.json().accessToken };
}

export const CAPACITY = { cpuCores: 4, ramMb: 8192, gpuPercent: 0, vramMb: 0, diskMb: 20_000, maxTemperatureC: 85 };

export async function heartbeat(h: Harness, w: TestWorker, body: object = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/worker/heartbeat',
    headers: auth(w.token),
    payload: {
      state: 'available',
      usage: { cpuPercent: 10, ramUsedMb: 4000, temperatureC: 50 },
      capacity: CAPACITY,
      workloadTypes: ['benchmark'],
      ...body,
    },
  });
}

export async function createJob(h: Harness, token: string, overrides: object = {}) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: auth(token),
    payload: { type: 'benchmark', name: 'primes', input: { kind: 'primes', size: 1000, iterations: 1 }, ...overrides },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
}

/** Runs the calibration protocol as an agent would, with a synthetic report. */
export async function calibrate(h: Harness, w: TestWorker, speeds: import('./calibration-fixtures.js').Speeds = {}) {
  const { syntheticReport } = await import('./calibration-fixtures.js');
  const { streamBytes } = await import('../src/performance/stream.js');
  const hb = await heartbeat(h, w, { workloadTypes: ['benchmark', 'image-inference'], agentVersion: '0.1.0' });
  const req = hb.json().calibration;
  if (!req) throw new Error(`no calibration requested: ${hb.body}`);
  const up = await h.app.inject({
    method: 'POST',
    url: `/v1/worker/calibration/${req.id}/upload`,
    headers: { ...auth(w.token), 'content-type': 'application/octet-stream' },
    payload: streamBytes(req.nonce, req.params.network.uploadBytes),
  });
  if (up.statusCode !== 200) throw new Error(up.body);
  const rep = await h.app.inject({
    method: 'POST',
    url: `/v1/worker/calibration/${req.id}/report`,
    headers: auth(w.token),
    payload: syntheticReport(req.params, req.nonce, speeds),
  });
  if (rep.statusCode !== 200) throw new Error(rep.body);
  return { request: req, result: rep.json() };
}
