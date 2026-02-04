import { loadConfig, type Config } from './config.js';
import { createPool } from './db/pool.js';
import { createRedis } from './redis/client.js';
import { EventBus } from './events/bus.js';
import { TaskQueue } from './queue/task-queue.js';
import type { AppContext } from './context.js';

export interface Runtime extends AppContext {
  close(): Promise<void>;
}

export async function createRuntime(config: Config = loadConfig()): Promise<Runtime> {
  const db = createPool(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const sub = createRedis(config.REDIS_URL);
  const bus = new EventBus(redis, sub);
  await bus.start();
  const queue = new TaskQueue(redis);
  return {
    config,
    db,
    redis,
    bus,
    queue,
    async close() {
      sub.disconnect();
      redis.disconnect();
      await db.end();
    },
  };
}
