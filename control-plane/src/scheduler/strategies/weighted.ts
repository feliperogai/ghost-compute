// Default strategy: greedy by priority; each job goes to the eligible worker
// with the best weighted score. Every component is normalized to [0, 1].
import { available, ineligibility, reserve, type EligibilityOptions } from '../eligibility.js';
import type { PlacementStrategy } from '../strategy.js';
import type { IneligibleReason, JobSpec, PlacementResult, ScoreBreakdown, WorkerSnapshot } from '../types.js';

export interface Weights {
  /** CPU headroom left after placing the job. */
  cpu: number;
  /** RAM headroom left after placing the job. */
  ram: number;
  /** GPU jobs: VRAM headroom. CPU jobs: prefer workers without a shared GPU (keep GPUs free). */
  gpu: number;
  /** Distance from the owner's temperature limit. */
  thermal: number;
  /** Owner's current CPU use and our own slot usage. */
  load: number;
  /** Past success rate on this worker. */
  reliability: number;
  /** Freshness of the last heartbeat. */
  availability: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  cpu: 0.2,
  ram: 0.15,
  gpu: 0.1,
  thermal: 0.15,
  load: 0.2,
  reliability: 0.15,
  availability: 0.05,
};

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const round = (v: number) => Math.round(v * 1000) / 1000;

export function score(job: JobSpec, w: WorkerSnapshot, o: EligibilityOptions, weights = DEFAULT_WEIGHTS): ScoreBreakdown {
  const cap = w.capacity!;
  const a = available(cap, w.reserved);
  const r = job.resources;
  const temp = w.usage?.temperatureC;
  const ownerCpu = Math.max(0, (w.usage?.cpuPercent ?? 0) - (w.usage?.cpuGhostPercent ?? 0));
  const ageMs = w.lastSeenAt ? o.now.getTime() - w.lastSeenAt.getTime() : o.offlineAfterMs;

  const c: Record<string, number> = {
    cpu: clamp01((a.cpuCores - r.cpuCores) / (cap.cpuCores || 1)),
    ram: clamp01((a.ramMb - r.ramMb) / (cap.ramMb || 1)),
    gpu: r.gpu ? clamp01((a.vramMb - r.vramMb) / (cap.vramMb || 1)) : cap.gpuPercent > 0 ? 0.5 : 1,
    thermal: temp == null ? 0.7 : clamp01((cap.maxTemperatureC - temp) / Math.max(1, cap.maxTemperatureC - 30)),
    load: clamp01(0.5 * (1 - ownerCpu / 100) + 0.5 * (1 - w.activeAssignments / Math.max(1, w.maxConcurrent))),
    reliability: (w.recent.completed + 1) / (w.recent.completed + w.recent.failed + 2),
    availability: clamp01(1 - ageMs / o.offlineAfterMs),
  };
  let total = 0;
  let wsum = 0;
  for (const [k, weight] of Object.entries(weights) as [keyof Weights, number][]) {
    total += weight * (c[k] ?? 0);
    wsum += weight;
  }
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, round(v)]));
  return { total: round(wsum ? total / wsum : 0), components };
}

export function weightedStrategy(weights: Weights = DEFAULT_WEIGHTS): PlacementStrategy {
  return {
    name: 'weighted',
    place(jobs, workers, o): PlacementResult {
      // Local copy: reservations made for earlier jobs in the batch count for later ones.
      const pool = new Map(workers.map((w) => [w.id, w]));
      const out: PlacementResult = { placements: [], unplaced: [] };
      for (const job of jobs) {
        const reasons: Partial<Record<IneligibleReason, number>> = {};
        let best: { w: WorkerSnapshot; s: ScoreBreakdown } | null = null;
        for (const w of pool.values()) {
          const why = ineligibility(job, w, o);
          if (why) {
            reasons[why] = (reasons[why] ?? 0) + 1;
            continue;
          }
          const s = score(job, w, o, weights);
          // Deterministic tie-break on id.
          if (!best || s.total > best.s.total || (s.total === best.s.total && w.id < best.w.id)) best = { w, s };
        }
        if (!best) {
          out.unplaced.push({ jobId: job.id, reasons });
          continue;
        }
        out.placements.push({ jobId: job.id, workerId: best.w.id, score: best.s });
        pool.set(best.w.id, reserve(best.w, job.resources));
      }
      return out;
    },
  };
}
