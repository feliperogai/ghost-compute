// Default strategy: explainable additive scoring.
//
//   worker_score = performance + availability + reliability + resource_fit
//                  − latency − current_load
//
// Every term is normalized to [0, 1] and multiplied by a weight that depends only on
// the job's priority band. No learning, no randomness: the same jobs and workers give
// the same placements and the same explanation text.
import { available, ineligibility, reserve, type EligibilityOptions } from '../eligibility.js';
import { estimateSeconds, performanceComponent, usesGpu } from '../performance.js';
import type { PlacementStrategy } from '../strategy.js';
import type {
  DecisionExplanation,
  IneligibleReason,
  JobSpec,
  PlacementResult,
  ScoreBreakdown,
  ScoreTerm,
  WorkerSnapshot,
} from '../types.js';

export const TERMS = ['performance', 'availability', 'reliability', 'resource_fit', 'latency', 'current_load'] as const;
export type TermName = (typeof TERMS)[number];
/** Terms that are subtracted. */
export const PENALTIES: readonly TermName[] = ['latency', 'current_load'];

export type Weights = Record<TermName, number>;

/** Priority changes what matters: urgent work wants the fastest machine, background work the cheapest fit. */
export const WEIGHTS_BY_PRIORITY: Record<'high' | 'normal' | 'low', Weights> = {
  high: { performance: 0.4, availability: 0.15, reliability: 0.2, resource_fit: 0.05, latency: 0.1, current_load: 0.1 },
  normal: { performance: 0.3, availability: 0.15, reliability: 0.2, resource_fit: 0.15, latency: 0.1, current_load: 0.1 },
  low: { performance: 0.2, availability: 0.1, reliability: 0.2, resource_fit: 0.3, latency: 0.1, current_load: 0.1 },
};
export const priorityBand = (p: number) => (p >= 70 ? 'high' : p < 30 ? 'low' : 'normal');

/** A worker is "established" after this long online without interruption. */
const STABLE_AFTER_MS = 60 * 60 * 1000;
/** Latency at which the latency term is 0.5. */
const LATENCY_REF_MS = 100;
/** Internal cost (credits) at which cost efficiency is 0.5. */
const COST_REF_CREDITS = 1;
/** Internal credits per minute: one per reserved core, GPUs weigh more (power, scarcity). */
const GPU_CREDITS_PER_MIN = 4;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface TermInput {
  value: number;
  factors: Record<string, number | string | null>;
}

function terms(job: JobSpec, w: WorkerSnapshot, o: EligibilityOptions): Record<TermName, TermInput> {
  const cap = w.capacity!;
  const a = available(cap, w.reserved);
  const res = job.resources;
  const p = w.performance ?? null;
  const est = estimateSeconds(job, w);

  // Performance: measured throughput for this job (real jobs first, then calibration).
  const obs = p?.observed[job.type];
  const performance = {
    value: performanceComponent(job, w),
    factors: {
      source: !p ? 'uncalibrated' : obs && obs.samples >= 3 ? 'observed' : job.work ? 'benchmark' : 'cpu-score',
      expectedSeconds: est === null ? null : r3(est),
      cpuScore: p?.cpuScore ?? null,
    },
  };

  // Availability: heartbeat freshness and how long it has been online without a break.
  const ageMs = w.lastSeenAt ? o.now.getTime() - w.lastSeenAt.getTime() : o.offlineAfterMs;
  const fresh = clamp01(1 - ageMs / o.offlineAfterMs);
  const onlineMs = w.onlineSince ? o.now.getTime() - w.onlineSince.getTime() : null;
  const stability = onlineMs === null ? 0.5 : clamp01(onlineMs / STABLE_AFTER_MS);
  const availability = {
    value: 0.5 * fresh + 0.5 * stability,
    factors: { heartbeatAgeS: r3(ageMs / 1000), onlineMinutes: onlineMs === null ? null : Math.floor(onlineMs / 60_000) },
  };

  // Reliability: failure rate over recent attempts (Laplace-smoothed, so a newcomer is 0.5).
  const { completed, failed } = w.recent;
  const reliability = {
    value: (completed + 1) / (completed + failed + 2),
    factors: { completed, failed },
  };

  // Resource fit: headroom left, not wasting a GPU, internal cost.
  const headroom = 0.5 * clamp01((a.cpuCores - res.cpuCores) / (cap.cpuCores || 1)) + 0.5 * clamp01((a.ramMb - res.ramMb) / (cap.ramMb || 1));
  const gpuJob = res.gpu || usesGpu(job, w);
  // Jobs that require a GPU: VRAM headroom (unknown VRAM counts as fine). Jobs that would
  // only opportunistically use it ("auto"), or not at all: the GPU is a scarce resource
  // being tied up, so a GPU machine fits worse; the performance term pays it back when
  // the GPU really is much faster.
  const vramFit = cap.vramMb ? clamp01((a.vramMb - res.vramMb) / cap.vramMb) : 1;
  const gpuFit = res.gpu ? vramFit : cap.gpuPercent > 0 ? 0.5 : 1;
  const ratePerMin = res.cpuCores + (gpuJob ? GPU_CREDITS_PER_MIN : 0);
  const cost = est === null ? null : (est / 60) * ratePerMin;
  const costEff = cost === null ? 0.5 : COST_REF_CREDITS / (COST_REF_CREDITS + cost);
  const resource_fit = {
    value: 0.4 * headroom + 0.3 * gpuFit + 0.3 * costEff,
    factors: { headroom: r3(headroom), gpuFit: r3(gpuFit), internalCostCredits: cost === null ? null : r3(cost) },
  };

  // Latency (penalty): matters most for jobs that move data item by item.
  const latMs = p?.network.latencyMs ?? null;
  const latRaw = latMs === null ? 0.3 : latMs / (latMs + LATENCY_REF_MS);
  const latency = {
    value: job.work ? latRaw : latRaw * 0.3,
    factors: { latencyMs: latMs, dataBound: job.work ? 1 : 0 },
  };

  // Current load (penalty): the owner's own CPU use, our slots in use, heat.
  const ownerCpu = Math.max(0, (w.usage?.cpuPercent ?? 0) - (w.usage?.cpuGhostPercent ?? 0));
  const slots = w.activeAssignments / Math.max(1, w.maxConcurrent);
  const temp = w.usage?.temperatureC;
  const heat = temp == null ? 0.3 : clamp01((temp - 30) / Math.max(1, cap.maxTemperatureC - 30));
  const current_load = {
    value: 0.4 * clamp01(ownerCpu / 100) + 0.3 * clamp01(slots) + 0.3 * heat,
    factors: { ownerCpuPercent: r3(ownerCpu), slotsUsed: w.activeAssignments, maxSlots: w.maxConcurrent, temperatureC: temp ?? null },
  };

  return { performance, availability, reliability, resource_fit, latency, current_load };
}

export function scoreWorker(job: JobSpec, w: WorkerSnapshot, o: EligibilityOptions): ScoreBreakdown {
  const weights = WEIGHTS_BY_PRIORITY[priorityBand(job.priority)];
  const t = terms(job, w, o);
  const out: Record<string, ScoreTerm> = {};
  let total = 0;
  for (const name of TERMS) {
    const sign = PENALTIES.includes(name) ? -1 : 1;
    const value = r3(clamp01(t[name].value));
    const contribution = r3(sign * weights[name] * value);
    total += contribution;
    out[name] = { value, weight: weights[name], contribution, factors: t[name].factors };
  }
  return {
    total: r3(total),
    components: Object.fromEntries(TERMS.map((n) => [n, out[n]!.value])),
    terms: out,
  };
}

// ---- explanation -----------------------------------------------------------------------

const REASON_PT: Record<IneligibleReason, string> = {
  OFFLINE: 'offline',
  NOT_ACCEPTING: 'dono não está compartilhando',
  NO_CAPACITY_REPORTED: 'sem capacidade informada',
  TYPE_UNSUPPORTED: 'não executa este tipo',
  OS_MISMATCH: 'sistema operacional diferente',
  CPU_FEATURES: 'CPU sem as instruções exigidas',
  INSUFFICIENT_CPU: 'CPU insuficiente',
  INSUFFICIENT_RAM: 'RAM insuficiente',
  NO_GPU: 'sem GPU compartilhada',
  GPU_NOT_CALIBRATED: 'GPU não calibrada',
  GPU_UNVERIFIED: 'GPU reprovada na calibração',
  TOO_SLOW: 'lento demais para o timeout',
  GPU_VENDOR: 'fabricante de GPU diferente',
  INSUFFICIENT_VRAM: 'VRAM insuficiente',
  INSUFFICIENT_DISK: 'disco insuficiente',
  TOO_HOT: 'temperatura perto do limite',
  NO_SLOTS: 'sem vaga livre',
  EXCLUDED: 'já falhou neste job',
};

const fmt = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
const num = (v: unknown) => (typeof v === 'number' ? fmt(v, Number.isInteger(v) ? 0 : 2) : String(v));
const plural = (n: unknown, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const label = (w: WorkerSnapshot) => (w.name ? `${w.name} (${w.id.slice(0, 8)})` : w.id.slice(0, 8));

/** Why one term favours the winner, in words, with the numbers behind it. */
function phrase(name: TermName, win: ScoreTerm, other: ScoreTerm | null): string {
  const f = win.factors;
  const o = other?.factors;
  const vs = (a: unknown, b: unknown, unit = '') =>
    b === undefined || b === null ? `${num(a)}${unit}` : `${num(a)}${unit} vs ${num(b)}${unit}`;
  switch (name) {
    case 'performance':
      return f.expectedSeconds !== null
        ? `desempenho medido melhor (${fmt(win.value)}; lote estimado em ${vs(f.expectedSeconds, o?.expectedSeconds, ' s')}, fonte: ${f.source})`
        : `desempenho medido melhor (${fmt(win.value)}; fonte: ${f.source})`;
    case 'availability':
      return `mais disponível (online há ${vs(f.onlineMinutes ?? '?', o?.onlineMinutes ?? undefined, ' min')})`;
    case 'reliability':
      return `mais confiável (${plural(f.completed, 'concluído', 'concluídos')}, ${plural(f.failed, 'falha recente', 'falhas recentes')}${o ? ` vs ${num(o.completed)}/${num(o.failed)}` : ''})`;
    case 'resource_fit':
      return f.internalCostCredits !== null
        ? `melhor encaixe de recursos e custo interno menor (${vs(f.internalCostCredits, o?.internalCostCredits, ' créditos')})`
        : `melhor encaixe de recursos (folga ${fmt(Number(f.headroom))}, GPU ${fmt(Number(f.gpuFit))})`;
    case 'latency':
      return `menor latência (${vs(f.latencyMs ?? '?', o?.latencyMs ?? undefined, ' ms')})`;
    case 'current_load':
      return `menos carregado (dono usando ${vs(f.ownerCpuPercent, o?.ownerCpuPercent, '% de CPU')}, ${f.slotsUsed}/${f.maxSlots} vagas, ${f.temperatureC ?? '?'} °C)`;
  }
}

export function explain(
  job: JobSpec,
  chosen: WorkerSnapshot,
  ranked: { w: WorkerSnapshot; s: ScoreBreakdown }[],
  rejected: Partial<Record<IneligibleReason, number>>,
): DecisionExplanation {
  const win = ranked[0]!;
  const runner = ranked[1] ?? null;
  const band = priorityBand(job.priority);
  let reasons: string[];
  if (!runner) {
    reasons = ['era o único worker elegível'];
  } else {
    // Terms ordered by how much they separate the winner from the runner-up.
    const diffs = TERMS.map((n) => ({ n, d: win.s.terms![n]!.contribution - runner.s.terms![n]!.contribution }))
      .filter((x) => x.d > 0.0005)
      .sort((a, b) => b.d - a.d || a.n.localeCompare(b.n));
    reasons = diffs.slice(0, 3).map((x) => phrase(x.n, win.s.terms![x.n]!, runner.s.terms![x.n]!));
    if (reasons.length === 0) reasons = ['empate no score; desempate determinístico pelo id'];
  }
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + (b ?? 0), 0);
  const rejectedText = Object.entries(rejected)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${n}× ${REASON_PT[k as IneligibleReason]}`)
    .join(', ');
  let summary = `Worker ${label(chosen)} foi escolhido porque ${reasons.join('; ')}.`;
  summary += runner
    ? ` Score ${fmt(win.s.total, 3)} contra ${fmt(runner.s.total, 3)} de ${label(runner.w)} (margem ${fmt(r3(win.s.total - runner.s.total), 3)}).`
    : ` Score ${fmt(win.s.total, 3)}.`;
  if (rejectedTotal) summary += ` ${rejectedTotal} worker(s) descartado(s): ${rejectedText}.`;
  summary += ` Prioridade ${job.priority} (${band}).`;
  return {
    summary,
    reasons,
    formula: 'performance + availability + reliability + resource_fit − latency − current_load',
    priorityBand: band,
    weights: WEIGHTS_BY_PRIORITY[band],
    chosen: { workerId: chosen.id, name: chosen.name ?? null, total: win.s.total, terms: win.s.terms! },
    runnerUp: runner ? { workerId: runner.w.id, name: runner.w.name ?? null, total: runner.s.total, margin: r3(win.s.total - runner.s.total) } : null,
    candidates: ranked.slice(0, 5).map((c) => ({ workerId: c.w.id, name: c.w.name ?? null, total: c.s.total, components: c.s.components })),
    rejected,
  };
}

// ---- strategy ----------------------------------------------------------------------------

export function scoreStrategy(): PlacementStrategy {
  return {
    name: 'score',
    place(jobs, workers, o): PlacementResult {
      // Local copy: reservations made for earlier jobs in the batch count for later ones.
      const pool = new Map(workers.map((w) => [w.id, w]));
      const out: PlacementResult = { placements: [], unplaced: [] };
      for (const job of jobs) {
        const rejected: Partial<Record<IneligibleReason, number>> = {};
        const ranked: { w: WorkerSnapshot; s: ScoreBreakdown }[] = [];
        for (const w of pool.values()) {
          const why = ineligibility(job, w, o);
          if (why) rejected[why] = (rejected[why] ?? 0) + 1;
          else ranked.push({ w, s: scoreWorker(job, w, o) });
        }
        if (ranked.length === 0) {
          out.unplaced.push({ jobId: job.id, reasons: rejected });
          continue;
        }
        // Highest score first; ties broken by id so the result never depends on input order.
        ranked.sort((a, b) => b.s.total - a.s.total || (a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0));
        const best = ranked[0]!;
        out.placements.push({ jobId: job.id, workerId: best.w.id, score: best.s, explanation: explain(job, best.w, ranked, rejected) });
        pool.set(best.w.id, reserve(best.w, job.resources));
      }
      return out;
    },
  };
}
