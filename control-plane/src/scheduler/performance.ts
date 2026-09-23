// Performance model: how long a job should take on a worker, from its measured profile.
// Pure; used by eligibility (TOO_SLOW, GPU checks) and by the weighted strategy.
import type { JobSpec, WorkerSnapshot } from './types.js';

/** Reference effective throughput (items/s incl. transfer) = 0.5 on the performance scale. */
export const REFERENCE_ITEMS_PER_SEC = 100;
/** Reference CPU score (1000 = reference machine). */
export const REFERENCE_CPU_SCORE = 1000;
/** Workers without a verified profile rank below the reference machine. */
export const UNCALIBRATED = 0.25;
/** Cost per attempt (sandbox start, module compile, GPU init) when the profile has none. */
export const STARTUP_SECONDS = 2;
/** Real-job samples needed before they replace the benchmark. */
export const MIN_OBSERVED_SAMPLES = 3;

/** Whether this job would run on the worker's GPU. */
export function usesGpu(job: JobSpec, w: WorkerSnapshot): boolean {
  const p = w.performance;
  if (!p?.gpu?.verified || !p.inference.gpuItemsPerSec || (w.capacity?.gpuPercent ?? 0) <= 0) return false;
  if (job.resources.gpu) return true;
  return job.work?.accelerator === 'auto' && p.inference.gpuItemsPerSec > p.inference.cpuItemsPerSec;
}

/** Items per second this worker sustains for the job, all costs included; null if unknown. */
export function effectiveRate(job: JobSpec, w: WorkerSnapshot): number | null {
  const p = w.performance;
  const work = job.work;
  if (!p || !work || work.items <= 0) return null;
  const gpu = usesGpu(job, w);
  const startupMs = (gpu ? p.inference.gpuStartupMs : p.inference.cpuStartupMs) ?? STARTUP_SECONDS * 1000;
  const obs = p.observed[job.type];
  // Real jobs include network and every per-item overhead: trust them once there are enough.
  if (obs && obs.samples >= MIN_OBSERVED_SAMPLES && obs.itemsPerSec > 0)
    return work.items / (startupMs / 1000 + work.items / obs.itemsPerSec);
  const compute = gpu ? p.inference.gpuItemsPerSec! : p.inference.cpuItemsPerSec;
  if (!(compute > 0)) return null;
  // Images are fetched one request at a time while the sandbox computes: the slower of
  // the two pipelines sets the pace.
  const transfer =
    (work.items * p.network.latencyMs) / 1000 +
    (p.network.downloadMbps ? (work.bytes * 8) / (p.network.downloadMbps * 1e6) : 0);
  const seconds = startupMs / 1000 + Math.max(work.items / compute, transfer);
  return work.items / seconds;
}

/** Expected seconds for one attempt, or null when there is no basis for an estimate. */
export function estimateSeconds(job: JobSpec, w: WorkerSnapshot): number | null {
  const rate = effectiveRate(job, w);
  return rate ? job.work!.items / rate : null;
}

/** Performance component of the placement score, in [0, 1]. Reference machine = 0.5. */
export function performanceComponent(job: JobSpec, w: WorkerSnapshot): number {
  const p = w.performance;
  if (!p) return UNCALIBRATED;
  const rate = effectiveRate(job, w);
  if (rate !== null) return rate / (rate + REFERENCE_ITEMS_PER_SEC);
  // Jobs without a size (e.g. benchmark): single-thread CPU speed.
  return p.cpuScore > 0 ? p.cpuScore / (p.cpuScore + REFERENCE_CPU_SCORE) : UNCALIBRATED;
}
