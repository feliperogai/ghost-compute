import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis } from '../src/redis/client.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { EventBus, type PlatformEvent, type WorkerMessage } from '../src/events/bus.js';

const redis = createRedis(process.env.REDIS_URL!);
const sub = createRedis(process.env.REDIS_URL!);
afterAll(() => {
  redis.disconnect();
  sub.disconnect();
});
beforeEach(() => redis.flushdb());

describe('JobQueue', () => {
  const q = new JobQueue(redis);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T00:00:01Z');

  it('orders by priority then age, peeks without removing', async () => {
    await q.enqueue([
      { jobId: 'old-low', priority: 0, createdAt: t0 },
      { jobId: 'new-high', priority: 50, createdAt: t1 },
      { jobId: 'old-high', priority: 50, createdAt: t0 },
    ]);
    expect(await q.peek(3)).toEqual(['old-high', 'new-high', 'old-low']);
    expect(await q.size()).toBe(3);
  });

  it('enqueue is idempotent; remove drops', async () => {
    await q.enqueue([{ jobId: 'a', priority: 0, createdAt: t0 }]);
    await q.enqueue([{ jobId: 'a', priority: 100, createdAt: t1 }]);
    expect(await q.size()).toBe(1);
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
    await bus.sendToWorker('w1', { type: 'assignment.cancel', assignmentId: 'a', reason: 'x' });
    const [ev, msg] = await got;
    expect(ev.type).toBe('job.created');
    expect(msg).toEqual({ type: 'assignment.cancel', assignmentId: 'a', reason: 'x' });
    expect(other).toBe(false);
  });
});
