// Credit rules. Pure and deterministic: same inputs → same amounts (and the inputs
// are stored with every transaction, so any amount can be recomputed by hand).
//
// Internal virtual credits only: they cannot be bought, sold or paid out.
// All amounts are integer millicredits (1 credit = 1000).
import type { Resources } from '../scheduler/types.js';

export const MILLI = 1000;

/** Millicredits per minute of each reserved resource. */
export const RATES = {
  cpuCore: 1000,
  ramGb: 250,
  gpu: 4000,
  vramGb: 250,
} as const;

/** Earnings of a worker without a verified benchmark profile. */
export const UNCALIBRATED_MULTIPLIER = 0.75;
export const PERFORMANCE_RANGE = [0.5, 2] as const;
/** Availability multiplier goes from AVAILABILITY_MIN (never online) to +AVAILABILITY_SPAN (always online). */
export const AVAILABILITY_MIN = 0.8;
export const AVAILABILITY_SPAN = 0.4;
export const AVAILABILITY_WINDOW_MIN = 24 * 60;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const toCredits = (milli: number) => milli / MILLI;

/** Parses a credit amount with at most 3 decimals into millicredits; null if not exact. */
export function toMilli(credits: number): number | null {
  const m = Math.round(credits * MILLI);
  return Number.isSafeInteger(m) && Math.abs(credits * MILLI - m) < 1e-6 ? m : null;
}

/** Cost of the reserved resources, millicredits per minute (integer, ≥ 1). */
export function ratePerMinute(r: Resources): number {
  const raw =
    r.cpuCores * RATES.cpuCore +
    (r.ramMb / 1024) * RATES.ramGb +
    (r.gpu ? RATES.gpu : 0) +
    (r.vramMb / 1024) * RATES.vramGb;
  return Math.max(1, Math.round(raw));
}

/** Reserved when the job is created: the most one attempt can cost (rate × timeout). */
export function holdAmount(r: Resources, timeoutSeconds: number): number {
  return Math.ceil((ratePerMinute(r) * timeoutSeconds) / 60);
}

/** What the job owner pays for one productive attempt: per second, rounded up. */
export function attemptCharge(rate: number, seconds: number): number {
  return Math.ceil((rate * Math.max(1, Math.ceil(seconds))) / 60);
}

export interface PerformanceInput {
  verified: boolean;
  /** Benchmark score of the device that ran the job (1000 = reference machine). */
  score: number | null;
}

export function performanceMultiplier(p: PerformanceInput): number {
  if (!p.verified || p.score === null || !(p.score > 0)) return UNCALIBRATED_MULTIPLIER;
  return r3(clamp(p.score / 1000, PERFORMANCE_RANGE[0], PERFORMANCE_RANGE[1]));
}

/** onlineMinutes: minutes with the worker available or running in the last window. */
export function availabilityMultiplier(onlineMinutes: number, windowMinutes = AVAILABILITY_WINDOW_MIN): number {
  const frac = clamp(onlineMinutes / windowMinutes, 0, 1);
  return r3(AVAILABILITY_MIN + AVAILABILITY_SPAN * frac);
}

export interface EarningInput {
  workerName: string;
  /** Wall time of the attempt, seconds. */
  seconds: number;
  resources: Resources;
  performance: PerformanceInput;
  onlineMinutes: number;
}

export interface Earning {
  amount: number;
  detail: {
    seconds: number;
    ratePerMinute: number;
    resources: Resources;
    performance: { verified: boolean; score: number | null; multiplier: number };
    availability: { onlineMinutes: number; windowMinutes: number; multiplier: number };
    formula: string;
    summary: string;
  };
}

const fmt = (v: number, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: d });

/**
 * earning = minutes × rate(resources) × performance × availability
 * (compute time × resources used × performance × availability, as millicredits, rounded down).
 */
export function computeEarning(i: EarningInput): Earning {
  const seconds = Math.max(0, Math.round(i.seconds * 1000) / 1000);
  const rate = ratePerMinute(i.resources);
  const perf = performanceMultiplier(i.performance);
  const avail = availabilityMultiplier(i.onlineMinutes);
  const amount = Math.floor((seconds / 60) * rate * perf * avail);
  const summary =
    `Worker ${i.workerName} ganhou ${fmt(toCredits(amount), 3)} créditos: ` +
    `${fmt(seconds / 60)} min × ${fmt(toCredits(rate), 3)} créditos/min (recursos) × ` +
    `desempenho ${fmt(perf, 3)}${i.performance.verified ? ` (score ${i.performance.score})` : ' (sem perfil verificado)'} × ` +
    `disponibilidade ${fmt(avail, 3)} (${fmt((100 * Math.min(i.onlineMinutes, AVAILABILITY_WINDOW_MIN)) / AVAILABILITY_WINDOW_MIN, 1)}% online nas últimas 24 h).`;
  return {
    amount,
    detail: {
      seconds,
      ratePerMinute: rate,
      resources: i.resources,
      performance: { verified: i.performance.verified, score: i.performance.score, multiplier: perf },
      availability: { onlineMinutes: i.onlineMinutes, windowMinutes: AVAILABILITY_WINDOW_MIN, multiplier: avail },
      formula: 'floor(seconds / 60 × ratePerMinute × performance × availability)',
      summary,
    },
  };
}
