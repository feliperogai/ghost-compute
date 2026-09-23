// The calibration suite: fixed, controlled tests with answers the server knows.
// A worker cannot claim a speed without also returning the right checksums/labels.
import { z } from 'zod';

/** CPU tests (built-in `benchmark` module). Checksums are deterministic outputs of the module. */
export const CPU_TESTS = [
  { kind: 'hash', size: 0, iterations: 1_200_000, checksum: '5023fee614ade0f7' },
  { kind: 'matmul', size: 128, iterations: 32, checksum: '40ffc9274d817680' },
  { kind: 'primes', size: 20_000_000, iterations: 1, checksum: '000000000013634f' },
] as const;

/**
 * Inference calibration images are embedded in the agent (24 digits: for each of 12
 * samples, PNG then JPEG). Image i of the run is sample i mod 24; these are its labels.
 */
export const CALIBRATION_LABELS = [7, 7, 6, 6, 3, 3, 7, 7, 7, 7, 3, 3, 2, 2, 8, 8, 9, 9, 3, 3, 2, 2, 6, 6] as const;
export const expectedLabel = (i: number) => CALIBRATION_LABELS[i % CALIBRATION_LABELS.length]!;

export const GPU_MATMUL_SIZES = [64, 128, 256, 512, 1024] as const;

/**
 * GPU matmul probe. A[i][k] = ((i+k) mod 7) − 3, B[k][j] = ((k·j) mod 5) − 2, C = A·B.
 * Every value is a small integer, exact in f32, so the checksum is exact on any GPU:
 * Σ C[i][j] · (((31·i + j) mod 17) + 1).
 */
const memo = new Map<number, string>();
export function gpuMatmulChecksum(n: number): string {
  const hit = memo.get(n);
  if (hit) return hit;
  const a = new Float64Array(n * n);
  const b = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      a[i * n + k] = ((i + k) % 7) - 3;
      b[i * n + k] = ((i * k) % 5) - 2;
    }
  // Σ_i Σ_k a[i][k] · (Σ_j b[k][j] · w(i, j)).
  let sum = 0;
  const row = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) row[j] = ((31 * i + j) % 17) + 1;
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k]!;
      if (aik === 0) continue;
      let s = 0;
      const off = k * n;
      for (let j = 0; j < n; j++) s += b[off + j]! * row[j]!;
      sum += aik * s;
    }
  }
  const out = String(sum);
  memo.set(n, out);
  return out;
}

export interface CalibrationParams {
  cpu: { kind: string; size: number; iterations: number }[];
  /** Parallel sandboxes run the first CPU test at the same time (bounded by the owner's cores). */
  parallel: { maxSandboxes: number };
  inference: { images: number };
  gpu: { size: number; maxIterations: number };
  network: { pings: number; downloadBytes: number; uploadBytes: number };
  storage: { bytes: number };
}

export const DEFAULT_PARAMS: CalibrationParams = {
  cpu: CPU_TESTS.map(({ kind, size, iterations }) => ({ kind, size, iterations })),
  parallel: { maxSandboxes: 8 },
  inference: { images: 240 },
  /** The agent repeats the product until ~0.3 s have passed (or maxIterations). */
  gpu: { size: 512, maxIterations: 4096 },
  network: { pings: 10, downloadBytes: 8 << 20, uploadBytes: 8 << 20 },
  storage: { bytes: 64 << 20 },
};

const ms = z.number().int().min(0).max(3_600_000);
const hex16 = z.string().regex(/^[0-9a-f]{16}$/);
const inferenceRun = z
  .object({
    images: z.number().int().min(2).max(512),
    /** From sandbox start to the first result (process start, module compile, GPU init). */
    firstItemMs: ms,
    /** From sandbox start to the last result. */
    elapsedMs: ms.min(1),
    labels: z.array(z.number().int().min(-1).max(9)).max(512),
    device: z.string().max(200).optional(),
  })
  .strict();

/** What the agent sends back. Strict: unknown fields are an error. */
export const reportSchema = z
  .object({
    agentVersion: z.string().max(50),
    cpu: z
      .object({
        threads: z.number().int().min(1).max(2048),
        offeredCores: z.number().min(0).max(1024),
        runs: z
          .array(
            z
              .object({
                kind: z.enum(['hash', 'matmul', 'primes']),
                size: z.number().int().min(0),
                iterations: z.number().int().min(1),
                checksum: hex16,
                elapsedMs: ms.min(1),
              })
              .strict(),
          )
          .max(8),
        parallel: z
          .object({ sandboxes: z.number().int().min(1).max(64), checksumsOk: z.number().int().min(0), wallMs: ms.min(1) })
          .strict()
          .nullable(),
      })
      .strict(),
    inference: z
      .object({ cpu: inferenceRun.nullable(), gpu: inferenceRun.nullable(), note: z.string().max(300).optional() })
      .strict(),
    gpu: z
      .object({
        name: z.string().max(200).optional(),
        vendor: z.string().max(50).optional(),
        vramTotalMb: z.number().int().min(0).max(1024 * 1024).optional(),
        vramUsedMb: z.number().int().min(0).max(1024 * 1024).optional(),
        matmul: z
          .object({
            size: z.number().int(),
            iterations: z.number().int().min(1).max(8192),
            elapsedMs: ms.min(1),
            checksum: z.string().regex(/^-?\d{1,20}$/),
            device: z.string().max(200),
            nvidia: z.boolean(),
          })
          .strict()
          .nullable(),
        note: z.string().max(300).optional(),
      })
      .strict()
      .nullable(),
    memory: z
      .object({
        totalMb: z.number().int().min(0).max(16 * 1024 * 1024),
        availableMb: z.number().int().min(0).max(16 * 1024 * 1024),
        offeredMb: z.number().int().min(0).max(16 * 1024 * 1024),
      })
      .strict(),
    storage: z
      .object({
        bytes: z.number().int().min(1),
        writeMs: ms.min(1),
        readMs: ms.min(1),
        syncSamples: z.number().int().min(1).max(1000),
        syncMs: ms.min(0),
      })
      .strict()
      .nullable(),
    network: z
      .object({
        rttMs: z.array(z.number().min(0).max(60_000)).min(1).max(50),
        download: z
          .object({ bytes: z.number().int().min(1), elapsedMs: ms.min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type CalibrationReport = z.infer<typeof reportSchema>;
