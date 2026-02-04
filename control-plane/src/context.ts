import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { Redis } from './redis/client.js';
import type { EventBus } from './events/bus.js';
import type { TaskQueue } from './queue/task-queue.js';

export interface AppContext {
  config: Config;
  db: Db;
  redis: Redis;
  bus: EventBus;
  queue: TaskQueue;
}
