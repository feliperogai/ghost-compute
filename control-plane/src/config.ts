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
  /** Seconds a worker has to accept an assignment before it is re-routed. */
  ASSIGNMENT_ACCEPT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  /** A running assignment not reported by heartbeat/progress for this long is considered lost. */
  ASSIGNMENT_STALE_SECONDS: z.coerce.number().int().min(10).max(3600).default(45),
  /** Placement algorithm (see src/scheduler/strategies). */
  SCHEDULER_STRATEGY: z.string().default('score'),
  /** Queued jobs considered per scheduling pass. */
  SCHEDULER_BATCH: z.coerce.number().int().min(1).max(5000).default(200),
  /** Do not place new work on workers within this many °C of their owner's limit. */
  THERMAL_MARGIN_C: z.coerce.number().min(0).max(30).default(3),
  JOB_DEFAULT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(604_800).default(3600),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Virtual credits given to every new user (internal, non-monetary). 0 = none. */
  CREDITS_INITIAL_GRANT: z.coerce.number().int().min(0).max(1_000_000_000).default(1000),
  /** Anyone may create a public account (role member) with POST /v1/signup. */
  OPEN_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Virtual credits for self-service accounts (lower than staff grants: accounts are free to create). */
  SIGNUP_CREDITS: z.coerce.number().int().min(0).max(1_000_000).default(100),
  /** Self-service accounts per IP per hour. */
  SIGNUP_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(5),
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
