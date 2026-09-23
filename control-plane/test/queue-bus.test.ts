import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis } from '../src/redis/client.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { EventBus, type PlatformEvent, type WorkerMessage } from '../src/events/bus.js';

const redis = createRedis(process.env.REDIS_URL!);
const sub = createRedis(process.env.REDIS_URL!);
afterAll(() => {
  redis.disconnect();
  sub.disconnect();
});
beforeEach(() => redis.flushdb());

describe('TaskQueue', () => {
  const q = new TaskQueue(redis);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T00:00:01Z');

  it('orders by priority then age', async () => {
    await q.enqueue([
      { taskId: 'old-low', priority: 0, createdAt: t0 },
      { taskId: 'new-high', priority: 50, createdAt: t1 },
      { taskId: 'old-high', priority: 50, createdAt: t0 },
    ]);
    expect((await q.pop(3)).map((i) => i.taskId)).toEqual(['old-high', 'new-high', 'old-low']);
  });

  it('enqueue is idempotent and restore keeps position', async () => {
    await q.enqueue([{ taskId: 'a', priority: 0, createdAt: t0 }]);
    await q.enqueue([{ taskId: 'a', priority: 100, createdAt: t1 }]);
    expect(await q.size()).toBe(1);
    const popped = await q.pop(1);
    await q.enqueue([{ taskId: 'b', priority: 0, createdAt: t1 }]);
    await q.restore(popped);
    expect((await q.pop(2)).map((i) => i.taskId)).toEqual(['a', 'b']);
  });

  it('removes', async () => {
    await q.enqueue([{ taskId: 'a', priority: 0, createdAt: t0 }]);
    await q.remove(['a']);
    expect(await q.size()).toBe(0);
  });
});

describe('EventBus', () => {
  it('delivers broadcast and worker-scoped messages', async () => {
    const bus = new EventBus(redis, sub);
    await bus.start();
    const got = new Promise<[PlatformEvent, WorkerMessage]>((resolve) => {
      let ev: PlatformEvent;
      bus.onBroadcast((e) => (ev = e));
      bus.onWorker('w1', (m) => resolve([ev, m]));
    });
    let other = false;
    bus.onWorker('w2', () => (other = true));
    await bus.publish('job.created', { id: 'j' });
    await bus.sendToWorker('w1', { type: 'lease.cancel', leaseId: 'l', reason: 'x' });
    const [ev, msg] = await got;
    expect(ev.type).toBe('job.created');
    expect(msg).toEqual({ type: 'lease.cancel', leaseId: 'l', reason: 'x' });
    expect(other).toBe(false);
  });
});
