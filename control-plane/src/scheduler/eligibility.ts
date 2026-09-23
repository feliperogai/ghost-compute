// Hard constraints. A worker that fails any check is never selected, whatever the strategy says.
import { workloadType } from './catalog.js';
import type { Capacity, IneligibleReason, JobSpec, Resources, WorkerSnapshot } from './types.js';
import { estimateSeconds } from './performance.js';

export interface EligibilityOptions {
  now: Date;
  /** A worker is offline after this long without a heartbeat. */
  offlineAfterMs: number;
  /** Stay this far below the owner's temperature limit when placing new work. */
  thermalMarginC: number;
}

export interface Available {
  cpuCores: number;
  ramMb: number;
  vramMb: number;
  diskMb: number;
  gpuFree: boolean;
}

export function available(cap: Capacity, reserved: Resources): Available {
  return {
    cpuCores: cap.cpuCores - reserved.cpuCores,
    ramMb: cap.ramMb - reserved.ramMb,
    vramMb: cap.vramMb - reserved.vramMb,
    diskMb: cap.diskMb - reserved.diskMb,
    // MVP: one GPU job per worker at a time.
    gpuFree: cap.gpuPercent > 0 && !reserved.gpu,
  };
}

const osOf = (w: WorkerSnapshot) => {
  const n = (w.hardware.os?.name ?? '').toLowerCase();
  if (n.includes('windows')) return 'windows';
  if (n.includes('darwin') || n.includes('mac')) return 'macos';
  if (n) return 'linux';
  return undefined;
};

/** Returns null when eligible, otherwise the first failing reason. */
export function ineligibility(job: JobSpec, w: WorkerSnapshot, o: EligibilityOptions): IneligibleReason | null {
  if (!w.lastSeenAt || o.now.getTime() - w.lastSeenAt.getTime() > o.offlineAfterMs) return 'OFFLINE';
  if (w.state !== 'available' && w.state !== 'running') return 'NOT_ACCEPTING';
  if (job.excludedWorkers.includes(w.id)) return 'EXCLUDED';
  if (!w.capacity) return 'NO_CAPACITY_REPORTED';
  if (!w.workloadTypes.includes(job.type)) return 'TYPE_UNSUPPORTED';
  if (w.activeAssignments >= w.maxConcurrent) return 'NO_SLOTS';

  const r = job.requirements;
  if (r.os && osOf(w) !== r.os) return 'OS_MISMATCH';
  if (r.cpuFeatures?.length) {
    const have = new Set((w.hardware.cpu?.features ?? []).map((f) => f.toLowerCase()));
    if (!r.cpuFeatures.every((f) => have.has(f.toLowerCase()))) return 'CPU_FEATURES';
  }
  if (r.minCpuCores && (w.hardware.cpu?.cores ?? 0) < r.minCpuCores) return 'INSUFFICIENT_CPU';
  if (r.minRamMb && (w.hardware.ramMb ?? 0) < r.minRamMb) return 'INSUFFICIENT_RAM';

  const needsGpu = job.resources.gpu || workloadType(job.type)?.requiresGpu === true || !!r.gpuVendor || !!r.minVramMb;
  const gpus = w.hardware.gpus ?? [];
  if (needsGpu) {
    if (gpus.length === 0 || w.capacity.gpuPercent <= 0) return 'NO_GPU';
    if (r.gpuVendor && !gpus.some((g) => (g.vendor ?? '').toLowerCase() === r.gpuVendor!.toLowerCase()))
      return 'GPU_VENDOR';
    const maxVram = Math.max(0, ...gpus.map((g) => g.vramMb ?? 0));
    if (r.minVramMb && maxVram < r.minVramMb) return 'INSUFFICIENT_VRAM';
    // A GPU in the inventory is not enough: it must have passed the calibration
    // (correct checksum on our shader, correct inference labels).
    if (!w.performance) return 'GPU_NOT_CALIBRATED';
    if (!w.performance.gpu?.verified) return 'GPU_UNVERIFIED';
    if (r.gpuVendor === 'NVIDIA' && !w.performance.gpu.nvidia) return 'GPU_VENDOR';
    const free = w.performance.gpu.vramAvailableMb;
    if (r.minVramMb && free !== null && free < r.minVramMb) return 'INSUFFICIENT_VRAM';
  }

  const a = available(w.capacity, w.reserved);
  const res = job.resources;
  if (res.cpuCores > a.cpuCores + 1e-9) return 'INSUFFICIENT_CPU';
  if (res.ramMb > a.ramMb) return 'INSUFFICIENT_RAM';
  if (res.diskMb > a.diskMb) return 'INSUFFICIENT_DISK';
  if (needsGpu && !a.gpuFree) return 'NO_GPU';
  if (res.vramMb > a.vramMb) return 'INSUFFICIENT_VRAM';

  const temp = w.usage?.temperatureC;
  if (temp != null && temp >= w.capacity.maxTemperatureC - o.thermalMarginC) return 'TOO_HOT';

  // Measured speed says it cannot finish in time: do not waste an attempt.
  const est = estimateSeconds(job, w);
  if (est !== null && job.timeoutSeconds && est > job.timeoutSeconds) return 'TOO_SLOW';
  return null;
}

/** Adds a job's resources to a worker's reservations (used while placing a batch). */
export function reserve(w: WorkerSnapshot, r: Resources): WorkerSnapshot {
  return {
    ...w,
    activeAssignments: w.activeAssignments + 1,
    reserved: {
      cpuCores: w.reserved.cpuCores + r.cpuCores,
      ramMb: w.reserved.ramMb + r.ramMb,
      gpu: w.reserved.gpu || r.gpu,
      vramMb: w.reserved.vramMb + r.vramMb,
      diskMb: w.reserved.diskMb + r.diskMb,
    },
  };
}

export function describeUnplaced(reasons: Partial<Record<IneligibleReason, number>>, workers: number): string {
  if (workers === 0) return 'no workers registered';
  const parts = Object.entries(reasons)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([r, n]) => `${n}× ${r}`);
  return `no eligible worker (${parts.join(', ')})`;
}
