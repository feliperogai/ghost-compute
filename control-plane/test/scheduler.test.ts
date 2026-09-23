import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJob, heartbeat, makeUser, registerWorker, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { WorkerMessage } from '../src/events/bus.js';

let h: Harness;
let op: string;
let s: Scheduler;
beforeAll(async () => {
  h = await setup();
  s = new Scheduler(h.rt, h.app.log);
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
});
afterAll(async () => {
  await s.stop();
  await h.close();
});

describe('scheduler', () => {
  it('pushes offers to available workers, balancing load', async () => {
    const a = await registerWorker(h, { name: 'a', maxConcurrentTasks: 2 });
    const b = await registerWorker(h, { name: 'b', maxConcurrentTasks: 2 });
    const paused = await registerWorker(h, { name: 'p', maxConcurrentTasks: 2 });
    await heartbeat(h, a);
    await heartbeat(h, b);
    await heartbeat(h, paused, { state: 'paused' });

    const got: Record<string, WorkerMessage[]> = { a: [], b: [], p: [] };
    h.rt.bus.onWorker(a.id, (m) => got.a!.push(m));
    h.rt.bus.onWorker(b.id, (m) => got.b!.push(m));
    h.rt.bus.onWorker(paused.id, (m) => got.p!.push(m));

    await createJob(h, op, { inputs: [{}, {}, {}, {}, {}] });
    const stats = await s.tick();
    expect(stats.offers).toBe(4);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.a).toHaveLength(2);
    expect(got.b).toHaveLength(2);
    expect(got.p).toHaveLength(0);
    expect(got.a![0]!.type).toBe('task.offer');
    expect(await h.rt.queue.size()).toBe(1);
  });

  it('reconciles a lost Redis queue from Postgres', async () => {
    await createJob(h, op, { inputs: [{}, {}] });
    await h.rt.redis.flushdb();
    const fresh = new Scheduler(h.rt, h.app.log);
    expect((await fresh.tick()).reconciled).toBe(2);
    expect(await h.rt.queue.size()).toBe(2);
  });

  it('detects offline workers and expires leases in one tick', async () => {
    const w = await registerWorker(h);
    await heartbeat(h, w);
    await createJob(h, op, { inputs: [{}] });
    await s.tick();
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    const stats = await s.tick();
    expect(stats.offline).toBe(1);
    expect(await h.rt.queue.size()).toBe(1);
  });

  it('only one instance leads', async () => {
    const other = new Scheduler(h.rt, h.app.log);
    expect(await s.tickIfLeader()).not.toBeNull();
    expect(await other.tickIfLeader()).toBeNull();
    await s.stop();
    expect(await other.tickIfLeader()).not.toBeNull();
    await other.stop();
  });
});
