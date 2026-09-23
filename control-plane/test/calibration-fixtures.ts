// Synthetic calibration reports for reproducible tests: exact checksums and labels,
// timings derived from the requested speeds (reference machine = factor 1).
import { createHash } from 'node:crypto';
import { REFERENCE } from '../src/performance/profile.js';
import { streamBytes } from '../src/performance/stream.js';
import { CPU_TESTS, DEFAULT_PARAMS, expectedLabel, gpuMatmulChecksum, type CalibrationParams, type CalibrationReport } from '../src/performance/suite.js';

export interface Speeds {
  cpuFactor?: number;
  inferCpu?: number;
  inferGpu?: number | null;
  gpuGflops?: number | null;
  gpuName?: string;
  nvidia?: boolean;
  vramTotalMb?: number;
  vramUsedMb?: number;
  rttMs?: number;
  downloadMbps?: number;
  /** Tampering switches. */
  wrongCpuChecksum?: boolean;
  wrongGpuChecksum?: boolean;
  wrongLabels?: number;
  wrongDownload?: boolean;
}

export function syntheticReport(params: CalibrationParams, nonce: string, s: Speeds = {}): CalibrationReport {
  const f = s.cpuFactor ?? 1;
  const runs = params.cpu.map((t) => {
    const known = CPU_TESTS.find((c) => c.kind === t.kind)!;
    const perSec =
      t.kind === 'hash' ? REFERENCE.hashesPerSec * f : t.kind === 'primes' ? REFERENCE.primesPerSec * f : REFERENCE.matmulMflops * f;
    const ops = t.kind === 'hash' ? t.iterations : t.kind === 'primes' ? t.size * t.iterations : (2 * t.size ** 3 * t.iterations) / 1e6;
    return {
      kind: t.kind as 'hash' | 'matmul' | 'primes',
      size: t.size,
      iterations: t.iterations,
      checksum: s.wrongCpuChecksum ? '0000000000000000' : known.checksum,
      elapsedMs: Math.max(1, Math.round((ops / perSec) * 1000)),
    };
  });
  const n = params.inference.images;
  const labels = (wrong: number) => Array.from({ length: n }, (_, i) => (i < wrong ? (expectedLabel(i) + 1) % 10 : expectedLabel(i)));
  const run = (rate: number, wrong = 0, device?: string) => ({
    images: n,
    firstItemMs: 500,
    elapsedMs: 500 + Math.round(((n - 1) * 1000) / rate),
    labels: labels(wrong),
    ...(device ? { device } : {}),
  });
  // Like the agent: enough iterations for ~0.5 s of work.
  const flop = 2 * params.gpu.size ** 3;
  const iters = s.gpuGflops ? Math.min(params.gpu.maxIterations, Math.ceil((0.5 * s.gpuGflops * 1e9) / flop)) : 1;
  const gpu = s.gpuGflops
    ? {
        name: s.gpuName ?? 'NVIDIA GeForce RTX 4070',
        vendor: s.nvidia === false ? 'AMD' : 'NVIDIA',
        vramTotalMb: s.vramTotalMb ?? 12_282,
        vramUsedMb: s.vramUsedMb ?? 800,
        matmul: {
          size: params.gpu.size,
          iterations: iters,
          elapsedMs: Math.max(1, Math.round(((flop * iters) / (s.gpuGflops * 1e9)) * 1000)),
          checksum: s.wrongGpuChecksum ? '12345' : gpuMatmulChecksum(params.gpu.size),
          device: `${s.gpuName ?? 'NVIDIA GeForce RTX 4070'} (Dx12)`,
          nvidia: s.nvidia !== false,
        },
      }
    : null;
  const bytes = params.network.downloadBytes;
  const dl = s.wrongDownload ? Buffer.alloc(bytes) : streamBytes(nonce, bytes);
  return {
    agentVersion: '0.1.0',
    cpu: {
      threads: 16,
      offeredCores: 8,
      runs,
      parallel: { sandboxes: 4, checksumsOk: 4, wallMs: Math.round(runs[0]!.elapsedMs * 1.25) },
    },
    inference: {
      cpu: run(s.inferCpu ?? REFERENCE.inferenceItemsPerSec, 0),
      gpu: gpu && s.inferGpu ? run(s.inferGpu, s.wrongLabels ?? 0, gpu.matmul.device) : null,
    },
    gpu,
    memory: { totalMb: 32_768, availableMb: 20_000, offeredMb: 8192 },
    storage: { bytes: params.storage.bytes, writeMs: 400, readMs: 100, syncSamples: 16, syncMs: 32 },
    network: {
      rttMs: Array.from({ length: params.network.pings }, (_, i) => (s.rttMs ?? 20) + (i % 3)),
      download: {
        bytes,
        elapsedMs: Math.max(1, Math.round(((bytes * 8) / ((s.downloadMbps ?? 100) * 1e6)) * 1000)),
        sha256: createHash('sha256').update(dl).digest('hex'),
      },
    },
  };
}

export { DEFAULT_PARAMS };
