import type { Redis } from '../redis/client.js';
import type { Db } from '../db/pool.js';

export const QUEUE_KEY = 'ghost:queue:jobs';

export interface QueueItem {
  jobId: string;
  score: number;
}

/**
 * Index of QUEUED jobs in a Redis sorted set: lower score = considered first
 * (higher priority, then older). Postgres is the source of truth; the scheduler
 * re-checks status on assignment and reconcile() rebuilds this index.
 */
export class JobQueue {
  constructor(private readonly redis: Redis) {}

  static score(priority: number, createdAt: Date): number {
    return (100 - priority) * 1e13 + createdAt.getTime();
  }

  async enqueue(items: { jobId: string; priority: number; createdAt: Date }[]): Promise<void> {
    if (items.length === 0) return;
    const args: (string | number)[] = [];
    for (const i of items) args.push(JobQueue.score(i.priority, i.createdAt), i.jobId);
    // NX: never reset the position of an already queued job.
    for (let n = 0; n < args.length; n += 1000) await this.redis.zadd(QUEUE_KEY, 'NX', ...args.slice(n, n + 1000));
  }

  /** Head of the queue, without removing (the scheduler removes on assignment). */
  async peek(count: number): Promise<string[]> {
    return this.redis.zrange(QUEUE_KEY, '0', String(count - 1));
  }

  async remove(jobIds: string[]): Promise<void> {
    if (jobIds.length > 0) await this.redis.zrem(QUEUE_KEY, ...jobIds);
  }

  async size(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY);
  }

  /** Rebuilds the index from Postgres: adds missing QUEUED jobs, drops everything else. */
  async reconcile(db: Db): Promise<number> {
    const { rows } = await db.query<{ id: string; priority: number; created_at: Date }>(
      `SELECT id, priority, created_at FROM jobs WHERE status = 'QUEUED'`,
    );
    const queued = new Set(rows.map((r) => r.id));
    const indexed = await this.redis.zrange(QUEUE_KEY, '0', '-1');
    await this.remove(indexed.filter((id) => !queued.has(id)));
    await this.enqueue(rows.map((r) => ({ jobId: r.id, priority: r.priority, createdAt: r.created_at })));
    return rows.length;
  }
}
