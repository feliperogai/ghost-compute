import type { Redis } from '../redis/client.js';
import type { Db } from '../db/pool.js';

export const QUEUE_KEY = 'ghost:queue:tasks';

export interface QueueItem {
  taskId: string;
  score: number;
}

/**
 * Pending-task index in a Redis sorted set.
 * Lower score = dispatched first: higher priority, then older.
 * Postgres remains the source of truth; reconcile() rebuilds this index.
 */
export class TaskQueue {
  constructor(private readonly redis: Redis) {}

  static score(priority: number, createdAt: Date): number {
    return (100 - priority) * 1e13 + createdAt.getTime();
  }

  async enqueue(items: { taskId: string; priority: number; createdAt: Date }[]): Promise<void> {
    if (items.length === 0) return;
    const args: (string | number)[] = [];
    for (const i of items) args.push(TaskQueue.score(i.priority, i.createdAt), i.taskId);
    // NX: never reset the position of an already queued task.
    for (let n = 0; n < args.length; n += 1000) await this.redis.zadd(QUEUE_KEY, 'NX', ...args.slice(n, n + 1000));
  }

  /** Atomically removes up to `count` head items. */
  async pop(count: number): Promise<QueueItem[]> {
    const raw = await this.redis.zpopmin(QUEUE_KEY, count);
    const out: QueueItem[] = [];
    for (let n = 0; n < raw.length; n += 2) out.push({ taskId: raw[n]!, score: Number(raw[n + 1]) });
    return out;
  }

  /** Puts popped items back with their original position. */
  async restore(items: QueueItem[]): Promise<void> {
    if (items.length === 0) return;
    const args: (string | number)[] = [];
    for (const i of items) args.push(i.score, i.taskId);
    await this.redis.zadd(QUEUE_KEY, 'NX', ...args);
  }

  async remove(taskIds: string[]): Promise<void> {
    if (taskIds.length > 0) await this.redis.zrem(QUEUE_KEY, ...taskIds);
  }

  async size(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY);
  }

  /** Re-adds every pending task from Postgres. Safe to run anytime. */
  async reconcile(db: Db): Promise<number> {
    const { rows } = await db.query<{ id: string; priority: number; created_at: Date }>(
      `SELECT t.id, j.priority, t.created_at
         FROM tasks t JOIN jobs j ON j.id = t.job_id
        WHERE t.status = 'pending' AND j.status IN ('queued', 'running')`,
    );
    await this.enqueue(rows.map((r) => ({ taskId: r.id, priority: r.priority, createdAt: r.created_at })));
    return rows.length;
  }
}
