import { z } from 'zod';

export const hardwareSchema = z.object({
  cpu: z.object({
    model: z.string().max(200),
    cores: z.number().int().min(1).max(1024),
    threads: z.number().int().min(1).max(2048),
    features: z.array(z.string().max(32)).max(128).default([]),
  }),
  ramMb: z.number().int().min(1).max(16 * 1024 * 1024),
  gpus: z
    .array(
      z.object({
        name: z.string().max(200),
        vendor: z.string().max(50).optional(),
        vramMb: z.number().int().min(0).max(1024 * 1024).optional(),
      }),
    )
    .max(16)
    .default([]),
  os: z.object({ name: z.string().max(100), version: z.string().max(100) }),
  diskFreeMb: z.number().int().min(0).optional(),
});
export type Hardware = z.infer<typeof hardwareSchema>;

/** Arbitrary JSON bounded by serialized size. */
export const boundedJson = (maxBytes: number) =>
  z.unknown().refine((v) => v !== undefined && Buffer.byteLength(JSON.stringify(v)) <= maxBytes, {
    message: `must be JSON of at most ${maxBytes} bytes`,
  });

export const uuidParam = z.object({ id: z.uuid() });

/** Body that may be omitted entirely (Fastify passes null). */
export const optionalBody = <T extends z.ZodType>(schema: T) => z.preprocess((v) => v ?? {}, schema);
