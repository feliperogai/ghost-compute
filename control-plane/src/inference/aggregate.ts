// Combines the batches of an inference run into one result. Pure: no I/O.
import { batchItems, CLASSES, imageInferenceInput } from './schemas.js';

export interface BatchRow {
  jobId: string;
  batchIndex: number;
  status: string;
  input: unknown;
  output: unknown;
  checkpoint: unknown;
  error: unknown;
  workerId: string | null;
  attempts: number;
}

export type GroupStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

export interface ResultItem {
  index: number;
  name?: string;
  label?: number;
  confidenceBp?: number;
  topK?: { label: number; confidenceBp: number }[];
  error?: string;
}

const items = (v: unknown) => (typeof v === 'object' && v !== null ? (v as { items?: unknown }).items : undefined);
const str = (v: unknown, k: string) =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[k] === 'string'
    ? ((v as Record<string, unknown>)[k] as string)
    : null;

/**
 * Every image of the dataset appears once, in index order: its prediction, the image's own
 * error (e.g. DECODE_ERROR), or why its batch produced nothing (BATCH_FAILED...).
 * Results of unfinished batches come from their checkpoint.
 */
export function combine(batches: BatchRow[], names: Map<number, string>, cancelled: boolean) {
  const all: ResultItem[] = [];
  const perBatch = [];
  const accelerators: Record<string, number> = {};
  for (const b of [...batches].sort((x, y) => x.batchIndex - y.batchIndex)) {
    const input = imageInferenceInput.safeParse(b.input);
    const expected = input.success ? input.data.images.map((i) => i.index) : [];
    const done = b.status === 'COMPLETED';
    const got = batchItems(b.input, items(done ? b.output : b.checkpoint));
    for (const index of expected) {
      const it: ResultItem = got.get(index) ?? { index, error: done ? 'MISSING_RESULT' : `BATCH_${b.status}` };
      const name = names.get(index);
      all.push(name ? { ...it, name } : it);
    }
    const accel = done ? str(b.output, 'accelerator') : null;
    if (accel) accelerators[accel] = (accelerators[accel] ?? 0) + 1;
    perBatch.push({
      batch: b.batchIndex,
      jobId: b.jobId,
      status: b.status,
      images: expected.length,
      completed: got.size,
      workerId: b.workerId,
      attempts: b.attempts,
      accelerator: accel,
      device: done ? str(b.output, 'device') : null,
      error: b.error ?? null,
    });
  }
  const byLabel: Record<string, number> = {};
  for (let l = 0; l < CLASSES; l++) byLabel[String(l)] = 0;
  let classified = 0;
  for (const it of all)
    if (it.label !== undefined) {
      classified++;
      byLabel[String(it.label)]!++;
    }
  const allDone = batches.every((b) => b.status === 'COMPLETED');
  const status: GroupStatus = cancelled ? 'CANCELLED' : allDone ? 'COMPLETED' : classified > 0 ? 'PARTIAL' : 'FAILED';
  return {
    status,
    result: {
      status,
      summary: {
        images: all.length,
        classified,
        failed: all.length - classified,
        byLabel,
        batches: batches.length,
        batchesCompleted: batches.filter((b) => b.status === 'COMPLETED').length,
        accelerators,
        workers: new Set(batches.map((b) => b.workerId).filter(Boolean)).size,
      },
      items: all,
      batches: perBatch,
    },
  };
}
