import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeUser, HW, enrollmentToken, setup, type Harness } from './helpers.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

let h: Harness;
let base: string;
let scheduler: Scheduler;
beforeAll(async () => {
  h = await setup({ SCHEDULER_TICK_MS: '100' });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address() as { port: number };
  base = `127.0.0.1:${addr.port}`;
  scheduler = new Scheduler(h.rt, h.app.log);
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

    // 10. heartbeat makes it available
    await api('POST', '/v1/worker/heartbeat', accessToken, {
      state: 'available',
      usage: { cpuPercent: 5, ramUsedMb: 3000 },
    });
    await dashboard.until((m) => m.event?.type === 'worker.online');

    const worker = connect(accessToken);
    await worker.until((m) => m.type === 'ready');

    // 6. create job
    const job = await api('POST', '/v1/jobs', operator, {
      name: 'squares',
      module: { name: 'square', version: '1.0.0' },
      inputs: [{ x: 2 }, { x: 3 }, { x: 4 }],
    });

    // 12-14. worker loop driven by pushed offers
    for (let done = 0; done < 3; ) {
      const msg = await worker.until((m) => m.type === 'task.offer');
      const { leaseId, input } = msg.offer;
      await api('POST', `/v1/worker/leases/${leaseId}/accept`, accessToken);
      await api('POST', `/v1/worker/leases/${leaseId}/progress`, accessToken, { progress: 0.5, stage: 'compute' });
      const output = { y: input.x * input.x };
      const outputSha256 = createHash('sha256').update(JSON.stringify(output)).digest('hex');
      await api('POST', `/v1/worker/leases/${leaseId}/result`, accessToken, { status: 'succeeded', output, outputSha256 });
      done++;
    }

    const finished = await dashboard.until((m) => m.event?.type === 'job.updated' && m.event.data.status === 'completed');
    expect(finished.event.data).toMatchObject({ jobId: job.id, succeededTasks: 3 });

    // 7. query
    const tasks = await api('GET', `/v1/jobs/${job.id}/tasks`, operator);
    expect(tasks.items.map((t: any) => t.output.y)).toEqual([4, 9, 16]);

    // 9. history
    const history = await api('GET', '/v1/jobs?status=completed', operator);
    expect(history.items[0].id).toBe(job.id);

    // 5. worker status
    const status = await api('GET', `/v1/workers/${reg.workerId}`, operator);
    expect(status).toMatchObject({ state: 'available', online: true, leases: [] });

    // 11. goes silent -> offline
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    await dashboard.until((m) => m.event?.type === 'worker.offline');

    worker.ws.close();
    dashboard.ws.close();
  });
});
