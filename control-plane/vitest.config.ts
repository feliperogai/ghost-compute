import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database and one Redis db.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://ghost:ghost@localhost:5432/ghost_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      WORKER_TOKEN_SECRET: 'test-secret-test-secret-test-secret-1234',
      SCHEDULER_ENABLED: 'false',
      // Spot checks are drawn at random; the tests that need them turn them on.
      TRUSTED_SPOT_CHECK_PERCENT: '0',
      // Staff must turn on two-step verification by default; the MFA tests turn it on.
      REQUIRE_STAFF_MFA: 'false',
    },
  },
});
