// Parameter schemas per registered workload type. They mirror the agent's own
// validation (agent/src/execution/registry.rs); both sides reject unknown fields.
import { z } from 'zod';

export const benchmarkInput = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('hash'), iterations: z.number().int().min(1).max(50_000_000), seed: z.number().int().optional() }).strict(),
    z
      .object({
        kind: z.literal('primes'),
        size: z.number().int().min(2).max(50_000_000),
        iterations: z.number().int().min(1).max(50_000_000),
        seed: z.number().int().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('matmul'),
        size: z.number().int().min(1).max(256),
        iterations: z.number().int().min(1).max(1000),
        seed: z.number().int().optional(),
      })
      .strict(),
  ]);

export const INPUT_SCHEMAS: Record<string, z.ZodType> = {
  benchmark: benchmarkInput,
};
