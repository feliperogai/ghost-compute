import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { LeaseService } from '../modules/leases/service.js';
import { WorkerService } from '../modules/workers/service.js';

const LOCK_KEY = 'ghost:scheduler:leader';
const RECONCILE_EVERY_TICKS = 30;

// Release only if we still own the lock.
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface TickStats {
  offline: number;
  expired: number;
  offers: number;
  reconciled?: number;
}

/**
 * Single-leader loop (Redis lock) that:
 *  1. marks silent workers offline and releases their leases;
 *  2. expires leases past their deadline;
 *  3. pushes offers to eligible workers over the event bus;
 *  4. periodically rebuilds the Redis queue from Postgres.
 * Correctness does not depend on the lock (all transitions are guarded in SQL);
 * it only avoids duplicate work.
 */
export class Scheduler {
  private readonly id = randomUUID();
  private readonly leases: LeaseService;
  private readonly workers: WorkerService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.leases = new LeaseService(ctx);
    this.workers = new WorkerService(ctx);
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      await this.tickIfLeader();
      if (this.timer) this.timer = setTimeout(loop, this.ctx.config.SCHEDULER_TICK_MS);
    };
    this.timer = setTimeout(loop, 0);
    this.log.info({ schedulerId: this.id }, 'scheduler started');
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 10));
    await this.ctx.redis.eval(RELEASE_LUA, 1, LOCK_KEY, this.id).catch(() => {});
  }

  private async acquire(): Promise<boolean> {
    const ttl = this.ctx.config.SCHEDULER_TICK_MS * 5;
    const got = await this.ctx.redis.set(LOCK_KEY, this.id, 'PX', ttl, 'NX');
    if (got === 'OK') return true;
    return (await this.ctx.redis.eval(RENEW_LUA, 1, LOCK_KEY, this.id, ttl)) === 1;
  }

  async tickIfLeader(): Promise<TickStats | null> {
    if (this.running) return null;
    this.running = true;
    try {
      if (!(await this.acquire())) return null;
      return await this.tick();
    } catch (err) {
      this.log.error({ err }, 'scheduler tick failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  /** One pass. Public for tests. */
  async tick(): Promise<TickStats> {
    const stats: TickStats = { offline: 0, expired: 0, offers: 0 };
    if (this.ticks++ % RECONCILE_EVERY_TICKS === 0) stats.reconciled = await this.ctx.queue.reconcile(this.ctx.db);

    stats.offline = (await this.workers.detectOffline()).length;
    stats.expired = await this.leases.expireDue();

    if ((await this.ctx.queue.size()) > 0) {
      const { rows } = await this.ctx.db.query<{ id: string }>(
        `SELECT w.id FROM workers w
          WHERE w.status = 'active' AND w.state IN ('available', 'running')
            AND w.max_concurrent_tasks >
                (SELECT count(*) FROM leases l WHERE l.worker_id = w.id AND l.status IN ('offered', 'running'))
          ORDER BY (SELECT count(*) FROM leases l WHERE l.worker_id = w.id AND l.status IN ('offered', 'running')),
                   w.last_seen_at DESC`,
      );
      for (const { id } of rows) {
        const offers = await this.leases.offerNext(id);
        for (const offer of offers) await this.ctx.bus.sendToWorker(id, { type: 'task.offer', offer: { ...offer } });
        stats.offers += offers.length;
        if ((await this.ctx.queue.size()) === 0) break;
      }
    }

    if (stats.offline || stats.expired || stats.offers) this.log.info({ stats }, 'scheduler tick');
    return stats;
  }
}
