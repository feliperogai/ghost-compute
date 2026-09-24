// image-inference: wire schemas shared by the API, the lifecycle (checkpoints) and
// aggregation. They mirror the agent (agent/src/execution/{registry,inference}.rs).
import { z } from 'zod';
import { creditAmount } from '../credits/pricing.js';

export const MAX_BATCH_IMAGES = 256;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_DATASET_IMAGES = 10_000;
export const MAX_DATASET_BYTES = 1024 * 1024 * 1024;
export const MAX_BATCHES = 2_000;
export const CLASSES = 10;

export const acceleratorSchema = z.enum(['cpu', 'auto', 'gpu']);

const imageRef = z
  .object({
    index: z.number().int().min(0).max(2 ** 31 - 1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  })
  .strict();

/** Job input (one batch). Jobs of this type are only created by the inference API. */
export const imageInferenceInput = z
  .object({
    images: z.array(imageRef).min(1).max(MAX_BATCH_IMAGES),
    accelerator: acceleratorSchema.optional(),
    topK: z.number().int().min(1).max(CLASSES).optional(),
  })
  .strict()
  .refine((i) => new Set(i.images.map((x) => x.index)).size === i.images.length, { message: 'duplicate image index' })
  .refine((i) => i.images.reduce((n, x) => n + x.size, 0) <= MAX_BATCH_BYTES, { message: 'batch too large' });
export type ImageInferenceInput = z.infer<typeof imageInferenceInput>;

const prediction = z
  .object({ label: z.number().int().min(0).max(CLASSES - 1), confidenceBp: z.number().int().min(0).max(10_000) })
  .strict();

/** One image's result as produced by the worker: a prediction or an error code. */
export const inferenceItem = z.union([
  z
    .object({
      index: z.number().int().min(0),
      label: z.number().int().min(0).max(CLASSES - 1),
      confidenceBp: z.number().int().min(0).max(10_000),
      topK: z.array(prediction).min(1).max(CLASSES),
    })
    .strict()
    .refine((i) => i.topK[0]!.label === i.label, { message: 'topK[0] must be the label' }),
  z.object({ index: z.number().int().min(0), error: z.string().regex(/^[A-Z_]{1,32}$/) }).strict(),
]);
export type InferenceItem = z.infer<typeof inferenceItem>;

/**
 * Keeps the items that belong to `input` (valid, expected index, first occurrence, topK within
 * the job's k). Used for checkpoints and final outputs alike: a worker cannot inject results
 * for images outside its batch.
 */
export function batchItems(input: unknown, items: unknown): Map<number, InferenceItem> {
  const out = new Map<number, InferenceItem>();
  const parsed = imageInferenceInput.safeParse(input);
  if (!parsed.success || !Array.isArray(items)) return out;
  const expected = new Set(parsed.data.images.map((i) => i.index));
  const k = parsed.data.topK ?? 3;
  for (const raw of items) {
    const r = inferenceItem.safeParse(raw);
    if (!r.success || !expected.has(r.data.index) || out.has(r.data.index)) continue;
    if ('topK' in r.data && r.data.topK.length > k) continue;
    out.set(r.data.index, r.data);
  }
  return out;
}

/** null if valid; otherwise why not. Strict: a checkpoint must be entirely valid. */
export function validateCheckpoint(input: unknown, checkpoint: unknown): string | null {
  if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) return 'must be an object';
  const keys = Object.keys(checkpoint);
  if (keys.length !== 1 || keys[0] !== 'items') return 'only "items" is allowed';
  const items = (checkpoint as { items: unknown }).items;
  if (!Array.isArray(items)) return 'items must be an array';
  if (items.length > MAX_BATCH_IMAGES) return 'too many items';
  if (batchItems(input, items).size !== items.length) return 'items do not match this batch';
  return null;
}

export const createDatasetSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export const createInferenceSchema = z
  .object({
    datasetId: z.uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    batchSize: z.number().int().min(1).max(MAX_BATCH_IMAGES).default(32),
    accelerator: acceleratorSchema.default('auto'),
    topK: z.number().int().min(1).max(CLASSES).default(3),
    priority: z.number().int().min(0).max(100).default(50),
    /** Per batch attempt, seconds. A timed-out batch is retried from its checkpoint. */
    timeoutSeconds: z.number().int().min(10).max(86_400).default(600),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    /** Like jobs: replicate (default for public accounts) or none. Verified batches do not resume from checkpoints. */
    verification: z.enum(['none', 'replicate']).optional(),
    /** Budget per batch, credits. Default: standard price × timeout × (replicas or maxAttempts). */
    budgetPerBatch: creditAmount.optional(),
    /** Only providers with at least this reputation (0–1000). */
    minReputation: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateInferenceInput = z.infer<typeof createInferenceSchema>;
