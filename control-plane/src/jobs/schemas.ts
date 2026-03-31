import { z } from 'zod';
import { WORKLOAD_TYPES, workloadType } from '../scheduler/catalog.js';
import { INPUT_SCHEMAS } from './workloads.js';
import { JOB_STATUSES } from '../scheduler/types.js';
import { creditAmount } from '../credits/pricing.js';

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_CHECKPOINT_BYTES = 256 * 1024;

const json = (maxBytes: number) =>
  z.unknown().refine((v) => v !== undefined && Buffer.byteLength(JSON.stringify(v)) <= maxBytes, {
    message: `must be JSON of at most ${maxBytes} bytes`,
  });

export const requirementsSchema = z
  .object({
    os: z.enum(['windows', 'linux', 'macos']).optional(),
    cpuFeatures: z.array(z.string().regex(/^[a-z0-9._]{1,32}$/i)).max(16).optional(),
    minCpuCores: z.number().int().min(1).max(1024).optional(),
    minRamMb: z.number().int().min(1).max(16 * 1024 * 1024).optional(),
    gpuVendor: z.enum(['NVIDIA', 'AMD', 'Intel']).optional(),
    minVramMb: z.number().int().min(1).max(1024 * 1024).optional(),
    /** Only providers with at least this reputation (0–1000). */
    minReputation: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const resourcesSchema = z
  .object({
    cpuCores: z.number().min(0.25).max(256).default(1),
    ramMb: z.number().int().min(16).max(1024 * 1024).default(512),
    gpu: z.boolean().default(false),
    vramMb: z.number().int().min(0).max(1024 * 1024).default(0),
    diskMb: z.number().int().min(0).max(10 * 1024 * 1024).default(0),
  })
  .strict()
  .refine((r) => r.gpu || r.vramMb === 0, { message: 'vramMb requires gpu: true', path: ['vramMb'] });

export const createJobSchema = z
  .object({
    type: z.enum(WORKLOAD_TYPES.map((t) => t.id) as [string, ...string[]]),
    name: z.string().trim().min(1).max(200).optional(),
    requirements: requirementsSchema.default({}),
    resources: resourcesSchema.default({ cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 }),
    priority: z.number().int().min(0).max(100).default(50),
    /** Max running time per attempt, seconds. */
    timeout: z.number().int().min(10).max(604_800).optional(),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    /** Most the job may cost, in credits (held at creation). Default: standard price × timeout. */
    budget: creditAmount.optional(),
    input: json(MAX_INPUT_BYTES),
  })
  .strict()
  .superRefine((j, ctx) => {
    const t = workloadType(j.type)!;
    if (t.requiresGpu && !j.resources.gpu)
      ctx.addIssue({ code: 'custom', path: ['resources', 'gpu'], message: `type '${j.type}' requires a GPU` });
    if (t.internal)
      ctx.addIssue({ code: 'custom', path: ['type'], message: `type '${j.type}' is created through ${t.internal}` });
    if (!t.supportsGpu && j.resources.gpu)
      ctx.addIssue({ code: 'custom', path: ['resources', 'gpu'], message: `type '${j.type}' cannot use a GPU` });
    // Parameters are validated per type: strict schemas, no free-form fields.
    const r = INPUT_SCHEMAS[j.type]!.safeParse(j.input);
    if (!r.success)
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['input', ...i.path.map(String)], message: i.message });
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const jobStatusSchema = z.enum(JOB_STATUSES);

export const resultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    output: json(MAX_OUTPUT_BYTES),
    outputSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }),
  z.object({
    status: z.literal('failed'),
    error: z.string().trim().min(1).max(2000),
    /** true = environment problem (retry elsewhere); false = the job itself is bad. */
    retryable: z.boolean().default(false),
  }),
]);

export const capacitySchema = z
  .object({
    cpuCores: z.number().min(0).max(1024),
    ramMb: z.number().int().min(0).max(16 * 1024 * 1024),
    gpuPercent: z.number().min(0).max(100),
    vramMb: z.number().int().min(0).max(1024 * 1024),
    diskMb: z.number().int().min(0).max(1024 * 1024 * 1024),
    maxTemperatureC: z.number().min(30).max(110),
  })
  .strict();
