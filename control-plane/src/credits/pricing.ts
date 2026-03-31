// Credit arithmetic. Pure and deterministic: same inputs → same amounts (and the inputs
// are stored with every transaction, so any amount can be recomputed by hand).
// RATES is the standard price; providers set their own (src/market/offer.ts).
//
// Internal virtual credits only: they cannot be bought, sold or paid out.
// All amounts are integer millicredits (1 credit = 1000).
import { z } from 'zod';
import type { Resources } from '../scheduler/types.js';

export const MILLI = 1000;

/** Standard price: millicredits per minute of each reserved resource. */
export const RATES = {
  cpuCore: 1000,
  ramGb: 250,
  gpu: 4000,
  vramGb: 250,
} as const;

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

/** Default budget when the customer sets none: standard price × timeout. */
export function holdAmount(r: Resources, timeoutSeconds: number): number {
  return Math.ceil((ratePerMinute(r) * timeoutSeconds) / 60);
}

/** What one productive attempt costs at `rate`: per second, rounded up. */
export function attemptCharge(rate: number, seconds: number): number {
  return Math.ceil((rate * Math.max(1, Math.ceil(seconds))) / 60);
}

/** Max credits in one grant, withdrawal or budget. */
export const MAX_CREDITS = 1_000_000_000;

/** Positive credit amount with at most 3 decimals → millicredits. Rejects 0, negatives, NaN, 1e-4. */
export const creditAmount = z
  .number()
  .positive()
  .max(MAX_CREDITS)
  .transform((v, ctx) => {
    const m = toMilli(v);
    if (m === null || m <= 0) {
      ctx.addIssue({ code: 'custom', message: 'amount must be a positive number of credits with at most 3 decimals' });
      return z.NEVER;
    }
    return m;
  });
