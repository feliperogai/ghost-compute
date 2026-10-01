// Random verification by trusted computers (spot checks). Which verified jobs get one is
// drawn with a cryptographic RNG when the job is created and never shown to providers,
// so colluding accounts cannot tell a job they could safely lie on.
import { randomInt } from 'node:crypto';

/** Whether a new verified job is spot-checked; `percent` of 0 … 100, in steps of 0.01. */
export function drawSpotCheck(percent: number): boolean {
  return percent > 0 && randomInt(0, 10_000) < Math.round(percent * 100);
}
