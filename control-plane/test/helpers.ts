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
    `TRUNCATE audit_log, task_events, leases, tasks, jobs, enrollment_tokens, workers, api_tokens, users CASCADE`,
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

export async function heartbeat(h: Harness, w: TestWorker, body: object = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/worker/heartbeat',
    headers: auth(w.token),
    payload: { state: 'available', usage: { cpuPercent: 10, ramUsedMb: 4000 }, ...body },
  });
}

export async function createJob(h: Harness, token: string, overrides: object = {}) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: auth(token),
    payload: {
      name: 'pi estimation',
      module: { name: 'monte-carlo-pi', version: '1.0.0' },
      params: { samples: 1000 },
      inputs: [{ seed: 1 }, { seed: 2 }],
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
}
