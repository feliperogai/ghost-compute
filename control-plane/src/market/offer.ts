// A provider's offer for one computer: price, availability windows, limits.
// Pure: validation, price of a job, "is it available now". No I/O.
import { z } from 'zod';
import { RATES } from '../credits/pricing.js';
import type { Resources } from '../scheduler/types.js';

/** Millicredits per minute of each reserved resource. */
export interface Price {
  cpuCore: number;
  ramGb: number;
  gpu: number;
  vramGb: number;
}

export interface AvailabilityWindow {
  /** 0 = Sunday … 6 = Saturday, in the offer's time zone. */
  days: number[];
  /** "HH:MM". end ≤ start means the window crosses midnight. */
  start: string;
  end: string;
}

export interface Availability {
  timezone: string;
  /** Empty: always available (while the agent shares). */
  windows: AvailabilityWindow[];
}

export interface Limits {
  maxCpuCores?: number;
  maxRamMb?: number;
  /** Longest job (timeout) this computer accepts. */
  maxJobSeconds?: number;
  maxConcurrent?: number;
  allowGpu?: boolean;
  /** Only these workload types (subset of what the agent supports). */
  workloadTypes?: string[];
}

export interface Offer {
  listed: boolean;
  price: Price;
  availability: Availability;
  limits: Limits;
}

export const STANDARD_PRICE: Price = { cpuCore: RATES.cpuCore, ramGb: RATES.ramGb, gpu: RATES.gpu, vramGb: RATES.vramGb };
export const DEFAULT_OFFER: Offer = { listed: true, price: STANDARD_PRICE, availability: { timezone: 'UTC', windows: [] }, limits: {} };

/** Price bounds, per unit: 0 to 100× the standard rate. */
export const MAX_PRICE_FACTOR = 100;

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
/** Credits (≤ 3 decimals) per minute → millicredits. */
const unitPrice = (standard: number) =>
  z
    .number()
    .min(0)
    .max((standard * MAX_PRICE_FACTOR) / 1000)
    .transform((v, ctx) => {
      const m = Math.round(v * 1000);
      if (Math.abs(v * 1000 - m) > 1e-6) {
        ctx.addIssue({ code: 'custom', message: 'at most 3 decimals' });
        return z.NEVER;
      }
      return m;
    });

/** Request body (prices in credits/min); stored values are millicredits. */
export const offerInputSchema = z
  .object({
    listed: z.boolean().optional(),
    price: z
      .object({
        cpuCore: unitPrice(RATES.cpuCore),
        ramGb: unitPrice(RATES.ramGb),
        gpu: unitPrice(RATES.gpu),
        vramGb: unitPrice(RATES.vramGb),
      })
      .strict()
      .refine((p) => p.cpuCore + p.ramGb + p.gpu + p.vramGb > 0, 'price cannot be all zero')
      .optional(),
    availability: z
      .object({
        timezone: z.string().max(64).refine(validTimezone, 'unknown time zone'),
        windows: z
          .array(
            z
              .object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm })
              .strict()
              .refine((w) => w.start !== w.end, 'start and end must differ'),
          )
          .max(28),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxCpuCores: z.number().min(0.25).max(256).optional(),
        maxRamMb: z.number().int().min(16).max(16 * 1024 * 1024).optional(),
        maxJobSeconds: z.number().int().min(10).max(604_800).optional(),
        maxConcurrent: z.number().int().min(1).max(256).optional(),
        allowGpu: z.boolean().optional(),
        workloadTypes: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(32).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OfferInput = z.infer<typeof offerInputSchema>;

/** Stored row (possibly partial or absent) → complete offer. */
export function normalizeOffer(row: Partial<Offer> | null | undefined): Offer {
  if (!row) return DEFAULT_OFFER;
  return {
    listed: row.listed ?? true,
    price: row.price ?? STANDARD_PRICE,
    availability: row.availability ?? DEFAULT_OFFER.availability,
    limits: row.limits ?? {},
  };
}

/** Provider's price for these resources, millicredits per minute (integer ≥ 1). */
export function priceRate(price: Price, r: Resources): number {
  const raw = r.cpuCores * price.cpuCore + (r.ramMb / 1024) * price.ramGb + (r.gpu ? price.gpu : 0) + (r.vramMb / 1024) * price.vramGb;
  return Math.max(1, Math.round(raw));
}

/** The most one attempt can cost: it is stopped at its timeout. */
export function maxAttemptCost(rate: number, timeoutSeconds: number): number {
  return Math.ceil((rate * timeoutSeconds) / 60);
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local weekday and minute of the day in `tz`. */
export function localTime(now: Date, tz: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { day: WEEKDAY[parts.weekday!]!, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Minutes left in the availability window containing `now`; Infinity when there are
 * no windows; 0 when outside every window. A window crossing midnight belongs to the
 * day it starts on.
 */
export function minutesLeft(a: Availability, now: Date): number {
  if (a.windows.length === 0) return Infinity;
  const { day, minute } = localTime(now, a.timezone);
  let best = 0;
  for (const w of a.windows) {
    const s = toMin(w.start);
    const e = toMin(w.end);
    if (e > s) {
      if (w.days.includes(day) && minute >= s && minute < e) best = Math.max(best, e - minute);
    } else {
      // Crosses midnight: [s, 24h) on its day, [0, e) on the next day.
      if (w.days.includes(day) && minute >= s) best = Math.max(best, 1440 - minute + e);
      if (w.days.includes((day + 6) % 7) && minute < e) best = Math.max(best, e - minute);
    }
  }
  return best;
}

/** Why the offer does not accept this job (null = accepted). */
export function offerRejects(
  o: Offer,
  job: { type: string; resources: Resources; timeoutSeconds?: number | undefined },
  activeAssignments: number,
  now: Date,
  /** The job would run on this computer's GPU (reserved, or "auto" with a GPU present). */
  usesGpu = job.resources.gpu,
): 'NOT_LISTED' | 'OUTSIDE_AVAILABILITY' | 'PROVIDER_LIMITS' | null {
  if (!o.listed) return 'NOT_LISTED';
  const l = o.limits;
  const r = job.resources;
  if (l.maxCpuCores !== undefined && r.cpuCores > l.maxCpuCores) return 'PROVIDER_LIMITS';
  if (l.maxRamMb !== undefined && r.ramMb > l.maxRamMb) return 'PROVIDER_LIMITS';
  if (l.maxJobSeconds !== undefined && (job.timeoutSeconds ?? Infinity) > l.maxJobSeconds) return 'PROVIDER_LIMITS';
  if (l.maxConcurrent !== undefined && activeAssignments >= l.maxConcurrent) return 'PROVIDER_LIMITS';
  if (l.allowGpu === false && usesGpu) return 'PROVIDER_LIMITS';
  if (l.workloadTypes && !l.workloadTypes.includes(job.type)) return 'PROVIDER_LIMITS';
  // The whole attempt must fit in the current window (the provider said "until then").
  const left = minutesLeft(o.availability, now);
  if (left <= 0 || (job.timeoutSeconds ?? 0) / 60 > left) return 'OUTSIDE_AVAILABILITY';
  return null;
}

/** Stored millicredits → credits for the API. */
export function priceView(p: Price) {
  return { cpuCore: p.cpuCore / 1000, ramGb: p.ramGb / 1000, gpu: p.gpu / 1000, vramGb: p.vramGb / 1000 };
}
