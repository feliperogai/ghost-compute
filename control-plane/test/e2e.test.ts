import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeUser, HW, enrollmentToken, setup, type Harness } from './helpers.js';
import { SchedulerRunner } from '../src/jobs/runner.js';

let h: Harness;
let base: string;
let scheduler: SchedulerRunner;
beforeAll(async () => {
  h = await setup({ SCHEDULER_TICK_MS: '100' });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address() as { port: number };
  base = `127.0.0.1:${addr.port}`;
  scheduler = new SchedulerRunner(h.rt, h.app.log);
  scheduler.start();
});
afterAll(async () => {
  await scheduler.stop();
  await h.close();
});

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`http://${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

function connect(token: string) {
  const ws = new WebSocket(`ws://${base}/v1/ws`);
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise<any>((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error('ws timeout')), 5000);
        });
  return {
    ws,
    async until(pred: (m: any) => boolean) {
      for (;;) {
        const m = await next();
        if (pred(m)) return m;
      }
    },
  };
}

describe('end to end', () => {
  it('worker registers, receives tasks by push, reports progress and results; job completes', async () => {
    const operator = await makeUser(h, 'operator');
    const dashboard = connect(operator);
    await dashboard.until((m) => m.type === 'ready');

    // 1-2. register + authenticate
    const reg = await api('POST', '/v1/workers/register', undefined, {
      enrollmentToken: await enrollmentToken(h),
      name: 'desk-01',
      hardware: HW,
      maxConcurrentTasks: 2,
    });
    const { accessToken } = await api('POST', '/v1/workers/auth', undefined, {
      workerId: reg.workerId,
      workerSecret: reg.workerSecret,
    });

    // Heartbeat: availability, capacity and supported workload types.
    const hb = {
      state: 'available',
      usage: { cpuPercent: 5, ramUsedMb: 3000, temperatureC: 48 },
      capacity: { cpuCores: 4, ramMb: 4096, gpuPercent: 0, vramMb: 0, diskMb: 10_000, maxTemperatureC: 85 },
      workloadTypes: ['benchmark'],
    };
    await api('POST', '/v1/worker/heartbeat', accessToken, hb);
    await dashboard.until((m) => m.event?.type === 'worker.online');

    const worker = connect(accessToken);
    await worker.until((m) => m.type === 'ready');

    // Jobs: received, analysed, matched, assigned and pushed by the running scheduler.
    const jobs = [];
    for (const x of [2, 3, 4]) {
      jobs.push(await api('POST', '/v1/jobs', operator, { type: 'benchmark', name: `primes ${x}`, input: { kind: 'primes', size: x * 10, iterations: 1 }, timeout: 60 }));
    }

    for (let done = 0; done < 3; ) {
      const msg = await worker.until((m) => m.type === 'job.assigned');
      const { assignmentId, input } = msg.assignment;
      await api('POST', `/v1/worker/assignments/${assignmentId}/accept`, accessToken);
      await api('POST', `/v1/worker/assignments/${assignmentId}/progress`, accessToken, { progress: 0.5, stage: 'compute' });
      // A mock worker: answers with the size it was asked for.
      const output = { size: input.size };
      const outputSha256 = createHash('sha256').update(JSON.stringify(output)).digest('hex');
      await api('POST', `/v1/worker/assignments/${assignmentId}/result`, accessToken, { status: 'completed', output, outputSha256 });
      done++;
    }

    await dashboard.until((m) => m.event?.type === 'job.updated' && m.event.data.status === 'COMPLETED');
    for (const j of jobs) {
      const got = await api('GET', `/v1/jobs/${j.id}`, operator);
      expect(got.status).toBe('COMPLETED');
      expect(got.output.size).toBe(got.input.size);
    }

    const history = await api('GET', '/v1/jobs?status=COMPLETED', operator);
    expect(history.items).toHaveLength(3);

    const stats = await api('GET', '/v1/worker/me/stats', accessToken);
    expect(stats.tasks.succeeded).toBe(3);

    const status = await api('GET', `/v1/workers/${reg.workerId}`, operator);
    expect(status).toMatchObject({ state: 'available', online: true, assignments: [] });

    // 11. goes silent -> offline
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    await dashboard.until((m) => m.event?.type === 'worker.offline');

    worker.ws.close();
    dashboard.ws.close();
  });
});
