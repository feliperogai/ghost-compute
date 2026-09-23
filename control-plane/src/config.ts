import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** HMAC key for worker session tokens. Min 32 chars. */
  WORKER_TOKEN_SECRET: z.string().min(32),
  WORKER_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  /** Worker is offline after this many seconds without heartbeat. */
  WORKER_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(3).max(3600).default(20),
  /** Seconds a worker has to accept an offer. */
  LEASE_OFFER_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  /** Running lease is extended by this much on each heartbeat/progress. */
  LEASE_RUNNING_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MAX_TASKS_PER_JOB: z.coerce.number().int().min(1).max(100_000).default(10_000),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
