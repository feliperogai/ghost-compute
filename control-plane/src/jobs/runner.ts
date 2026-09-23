// Runs the scheduler engine on a timer, on one control-plane instance at a time.
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { createStrategy, SchedulerEngine, type TickReport } from '../scheduler/index.js';
import { PgSchedulerStore } from './scheduler-store.js';

const LOCK_KEY = 'ghost:scheduler:leader';
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export function createEngine(ctx: AppContext, log?: FastifyBaseLogger): SchedulerEngine {
  const store = new PgSchedulerStore(ctx);
  return new SchedulerEngine(store, store, createStrategy(ctx.config.SCHEDULER_STRATEGY), {
    batchSize: ctx.config.SCHEDULER_BATCH,
    offlineAfterMs: ctx.config.WORKER_OFFLINE_AFTER_SECONDS * 1000,
    thermalMarginC: ctx.config.THERMAL_MARGIN_C,
    reconcileEveryTicks: 30,
  }, log);
}

/**
 * Correctness does not depend on the leader lock (every transition is guarded in SQL);
 * it avoids duplicate work and keeps placement decisions single-threaded.
 */
export class SchedulerRunner {
  private readonly id = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly engine: SchedulerEngine;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.engine = createEngine(ctx, log);
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      await this.tickIfLeader();
      if (this.timer) this.timer = setTimeout(loop, this.ctx.config.SCHEDULER_TICK_MS);
    };
    this.timer = setTimeout(loop, 0);
    this.log.info({ schedulerId: this.id, strategy: this.engine.strategyName }, 'scheduler started');
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 10));
    await this.ctx.redis.eval(RELEASE_LUA, 1, LOCK_KEY, this.id).catch(() => {});
  }

  private async acquire(): Promise<boolean> {
    const ttl = this.ctx.config.SCHEDULER_TICK_MS * 5;
    if ((await this.ctx.redis.set(LOCK_KEY, this.id, 'PX', ttl, 'NX')) === 'OK') return true;
    return (await this.ctx.redis.eval(RENEW_LUA, 1, LOCK_KEY, this.id, ttl)) === 1;
  }

  async tickIfLeader(): Promise<TickReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      if (!(await this.acquire())) return null;
      return await this.engine.tick();
    } catch (err) {
      this.log.error({ err }, 'scheduler pass failed');
      return null;
    } finally {
      this.running = false;
    }
  }
}
