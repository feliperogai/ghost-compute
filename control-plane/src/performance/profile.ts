// Builds a WorkerPerformanceProfile from a calibration report. Pure and deterministic:
// same report + same server measurements → same profile (see test/performance.test.ts).
import type { CalibrationParams, CalibrationReport } from './suite.js';
import { CPU_TESTS, expectedLabel, gpuMatmulChecksum } from './suite.js';
import { streamSha256 } from './stream.js';

/** Reference machine = 1000 points in every score. */
export const REFERENCE = {
  hashesPerSec: 2_000_000,
  matmulMflops: 500,
  primesPerSec: 50_000_000,
  gpuGflops: 1_000,
  inferenceItemsPerSec: 500,
  downloadMbps: 100,
  uploadMbps: 50,
  latencyMs: 20,
  seqWriteMBps: 200,
  seqReadMBps: 500,
  syncLatencyMs: 5,
} as const;

export interface InferenceMeasure {
  itemsPerSec: number;
  /** Per-image processing time once running. */
  avgLatencyMs: number;
  /** Sandbox start → first result (process, module compile, GPU init). */
  startupMs: number;
  accuracyBp: number;
  device?: string;
}

export interface WorkerPerformanceProfile {
  version: 1;
  verified: boolean;
  issues: string[];
  calibratedAt: string;
  agentVersion: string;
  cpu: {
    model: string | null;
    threads: number;
    offeredCores: number;
    singleThread: { hashesPerSec: number; matmulMflops: number; primesPerSec: number };
    parallel: { sandboxes: number; speedup: number } | null;
    score: number;
    multiScore: number;
  };
  gpu: {
    name: string | null;
    vendor: string | null;
    nvidia: boolean;
    vramTotalMb: number | null;
    vramAvailableMb: number | null;
    matmulGflops: number | null;
    verified: boolean;
    score: number;
  } | null;
  memory: { totalMb: number; availableMb: number; offeredMb: number };
  network: {
    latencyMs: { min: number; median: number; p95: number };
    downloadMbps: number | null;
    uploadMbps: number | null;
    score: number;
  };
  storage: { seqWriteMBps: number; seqReadMBps: number; syncLatencyMs: number; score: number } | null;
  inference: {
    cpu: InferenceMeasure | null;
    gpu: InferenceMeasure | null;
    best: 'cpu' | 'gpu' | null;
    itemsPerSec: number;
    avgLatencyMs: number | null;
    score: number;
  };
  scores: { cpu: number; gpu: number; inference: number; network: number; storage: number; overall: number };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const points = (ratio: number) => (Number.isFinite(ratio) && ratio > 0 ? Math.round(1000 * ratio) : 0);
const geomean = (xs: number[]) => {
  const ok = xs.filter((x) => Number.isFinite(x) && x > 0);
  return ok.length ? Math.exp(ok.reduce((s, x) => s + Math.log(x), 0) / ok.length) : 0;
};
function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
}

function inferenceMeasure(
  run: NonNullable<CalibrationReport['inference']['cpu']>,
  images: number,
): { m: InferenceMeasure; correct: number } {
  let correct = 0;
  run.labels.forEach((l, i) => {
    if (l === expectedLabel(i)) correct++;
  });
  const busyMs = Math.max(1, run.elapsedMs - run.firstItemMs);
  const itemsPerSec = ((run.images - 1) * 1000) / busyMs;
  return {
    correct,
    m: {
      itemsPerSec: r1(itemsPerSec),
      avgLatencyMs: r1(1000 / itemsPerSec),
      startupMs: run.firstItemMs,
      accuracyBp: Math.round((correct * 10_000) / Math.max(1, images)),
      ...(run.device ? { device: run.device } : {}),
    },
  };
}

export interface ServerMeasured {
  upload?: { bytes: number; elapsedMs: number; ok: boolean };
}

export function buildProfile(
  report: CalibrationReport,
  params: CalibrationParams,
  nonce: string,
  measured: ServerMeasured,
  hardware: { cpu?: { model?: string } } | null,
  now: Date,
): WorkerPerformanceProfile {
  const issues: string[] = [];

  // ---- CPU: every run must be the requested test with the known checksum.
  const rate: Record<string, number> = {};
  params.cpu.forEach((t, i) => {
    const run = report.cpu.runs[i];
    const known = CPU_TESTS.find((c) => c.kind === t.kind && c.size === t.size && c.iterations === t.iterations);
    if (!run || run.kind !== t.kind || run.size !== t.size || run.iterations !== t.iterations) {
      issues.push(`CPU_TEST_MISSING:${t.kind}`);
      return;
    }
    if (!known || run.checksum !== known.checksum) {
      issues.push(`CPU_CHECKSUM:${t.kind}`);
      return;
    }
    const ops = t.kind === 'hash' ? t.iterations : t.kind === 'primes' ? t.size * t.iterations : (2 * t.size ** 3 * t.iterations) / 1e6;
    rate[t.kind] = (ops * 1000) / run.elapsedMs;
  });
  const single = {
    hashesPerSec: Math.round(rate.hash ?? 0),
    matmulMflops: Math.round(rate.matmul ?? 0),
    primesPerSec: Math.round(rate.primes ?? 0),
  };
  const cpuScore = points(
    geomean([
      single.hashesPerSec / REFERENCE.hashesPerSec,
      single.matmulMflops / REFERENCE.matmulMflops,
      single.primesPerSec / REFERENCE.primesPerSec,
    ]),
  );
  let parallel: WorkerPerformanceProfile['cpu']['parallel'] = null;
  const p = report.cpu.parallel;
  const firstRun = report.cpu.runs[0];
  if (p) {
    if (p.checksumsOk !== p.sandboxes) issues.push('CPU_PARALLEL_CHECKSUM');
    else if (firstRun && rate[params.cpu[0]!.kind]) {
      // Ideal: N sandboxes finish in the time of one.
      parallel = { sandboxes: p.sandboxes, speedup: r1(Math.min(p.sandboxes, (p.sandboxes * firstRun.elapsedMs) / p.wallMs)) };
    }
  }

  // ---- Inference: labels of the embedded calibration set are known.
  const images = params.inference.images;
  let cpuInf: InferenceMeasure | null = null;
  let gpuInf: InferenceMeasure | null = null;
  const ci = report.inference.cpu;
  if (!ci || ci.images !== images || ci.labels.length !== images) issues.push('INFERENCE_CPU_MISSING');
  else {
    const { m, correct } = inferenceMeasure(ci, images);
    // The CPU path is bit-exact: every label must match.
    if (correct !== images) issues.push('INFERENCE_CPU_MISMATCH');
    else cpuInf = m;
  }
  const gi = report.inference.gpu;
  let gpuInfOk = false;
  if (gi) {
    if (gi.images !== images || gi.labels.length !== images) issues.push('INFERENCE_GPU_MISSING');
    else {
      const { m } = inferenceMeasure(gi, images);
      // GPU floats may round differently; nearly every label must still match.
      if (m.accuracyBp < 9_500) issues.push('INFERENCE_GPU_MISMATCH');
      else {
        gpuInf = m;
        gpuInfOk = true;
      }
    }
  }

  // ---- GPU compute.
  let gpu: WorkerPerformanceProfile['gpu'] = null;
  if (report.gpu) {
    const mm = report.gpu.matmul;
    let gflops: number | null = null;
    let ok = false;
    if (mm) {
      if (mm.size !== params.gpu.size || mm.checksum !== gpuMatmulChecksum(params.gpu.size)) issues.push('GPU_CHECKSUM');
      else {
        ok = true;
        gflops = r1((2 * mm.size ** 3 * mm.iterations) / (mm.elapsedMs / 1000) / 1e9);
      }
    }
    const total = report.gpu.vramTotalMb ?? null;
    const used = report.gpu.vramUsedMb ?? null;
    const verified = ok && (gi === null || gpuInfOk);
    gpu = {
      name: report.gpu.name ?? mm?.device ?? null,
      vendor: report.gpu.vendor ?? (mm?.nvidia ? 'NVIDIA' : null),
      nvidia: !!mm?.nvidia || (report.gpu.vendor ?? '').toUpperCase() === 'NVIDIA',
      vramTotalMb: total,
      vramAvailableMb: total !== null ? Math.max(0, total - (used ?? 0)) : null,
      matmulGflops: gflops,
      verified,
      score: verified && gflops ? points(gflops / REFERENCE.gpuGflops) : 0,
    };
    if (!verified) gpuInf = null;
  }

  // ---- Network: latency from pings; download proven by hash; upload measured by the server.
  const rtt = report.network.rttMs;
  const latency = { min: r1(Math.min(...rtt)), median: r1(quantile(rtt, 0.5)), p95: r1(quantile(rtt, 0.95)) };
  let downloadMbps: number | null = null;
  const d = report.network.download;
  if (d) {
    if (d.bytes !== params.network.downloadBytes || d.sha256 !== streamSha256(nonce, d.bytes)) issues.push('DOWNLOAD_MISMATCH');
    else downloadMbps = r1((d.bytes * 8) / (d.elapsedMs / 1000) / 1e6);
  }
  const up = measured.upload;
  const uploadMbps = up?.ok ? r1((up.bytes * 8) / (Math.max(1, up.elapsedMs) / 1000) / 1e6) : null;
  if (up && !up.ok) issues.push('UPLOAD_MISMATCH');
  const networkScore = points(
    geomean([
      (downloadMbps ?? 0) / REFERENCE.downloadMbps,
      (uploadMbps ?? 0) / REFERENCE.uploadMbps,
      REFERENCE.latencyMs / Math.max(0.1, latency.median),
    ]),
  );

  // ---- Storage.
  const s = report.storage;
  const storage = s
    ? (() => {
        const w = (s.bytes / 1e6) / (s.writeMs / 1000);
        const rd = (s.bytes / 1e6) / (s.readMs / 1000);
        const sync = s.syncMs / s.syncSamples;
        return {
          seqWriteMBps: r1(w),
          seqReadMBps: r1(rd),
          syncLatencyMs: r1(sync),
          score: points(
            geomean([w / REFERENCE.seqWriteMBps, rd / REFERENCE.seqReadMBps, REFERENCE.syncLatencyMs / Math.max(0.05, sync)]),
          ),
        };
      })()
    : null;

  // ---- Inference summary: the faster verified path.
  const best = gpuInf && (!cpuInf || gpuInf.itemsPerSec > cpuInf.itemsPerSec) ? 'gpu' : cpuInf ? 'cpu' : null;
  const bestM = best === 'gpu' ? gpuInf : best === 'cpu' ? cpuInf : null;
  const inference = {
    cpu: cpuInf,
    gpu: gpuInf,
    best,
    itemsPerSec: bestM?.itemsPerSec ?? 0,
    avgLatencyMs: bestM?.avgLatencyMs ?? null,
    score: points((bestM?.itemsPerSec ?? 0) / REFERENCE.inferenceItemsPerSec),
  } as WorkerPerformanceProfile['inference'];

  const scores = {
    cpu: cpuScore,
    gpu: gpu?.score ?? 0,
    inference: inference.score,
    network: networkScore,
    storage: storage?.score ?? 0,
    overall: 0,
  };
  scores.overall = Math.round(
    0.3 * scores.cpu + 0.3 * scores.inference + 0.2 * scores.network + 0.1 * scores.gpu + 0.1 * scores.storage,
  );

  return {
    version: 1,
    // Results from this worker are trustworthy only if the deterministic CPU paths check out.
    verified: !issues.some((i) => i.startsWith('CPU_') || i.startsWith('INFERENCE_CPU')),
    issues,
    calibratedAt: now.toISOString(),
    agentVersion: report.agentVersion,
    cpu: {
      model: hardware?.cpu?.model ?? null,
      threads: report.cpu.threads,
      offeredCores: report.cpu.offeredCores,
      singleThread: single,
      parallel,
      score: cpuScore,
      multiScore: Math.round(cpuScore * (parallel?.speedup ?? 1)),
    },
    gpu,
    memory: report.memory,
    network: { latencyMs: latency, downloadMbps, uploadMbps, score: networkScore },
    storage,
    inference,
    scores,
  };
}

/** Human summary (the "card" shown to operators). */
export function summarize(p: WorkerPerformanceProfile, observed: Observed) {
  const gb = (mb: number | null | undefined) => (mb == null ? null : `${Math.round((mb / 1024) * 10) / 10} GB`);
  const obs = observed['image-inference'];
  return {
    gpu: p.gpu?.name ?? null,
    vram: gb(p.gpu?.vramTotalMb),
    vramAvailable: gb(p.gpu?.vramAvailableMb),
    ramAvailable: gb(p.memory.availableMb),
    scoreInference: p.scores.inference,
    scoreOverall: p.scores.overall,
    averageLatencyMs: p.network.latencyMs.median,
    inferenceLatencyMs: p.inference.avgLatencyMs,
    throughputItemsPerSec: p.inference.itemsPerSec,
    observedItemsPerSec: obs && obs.samples > 0 ? obs.itemsPerSec : null,
    verified: p.verified,
  };
}

export type Observed = Record<string, { itemsPerSec: number; samples: number; updatedAt: string }>;
