// What happens to a job when an attempt ends without success.

export type AttemptOutcome =
  /** Worker declined the offer (busy owner, paused...). Not the job's fault. */
  | { kind: 'rejected' }
  /** Worker did not accept in time. */
  | { kind: 'expired' }
  /** Worker vanished (offline, stopped reporting the assignment) or was revoked. */
  | { kind: 'lost' }
  /** Job failed on the worker. `retryable` = environment problem rather than bad input. */
  | { kind: 'failed'; retryable: boolean }
  /** Attempt ran past the job's timeout (only for resumable jobs; others end as TIMEOUT). */
  | { kind: 'timeout' };

export type RetryDecision = 'REQUEUE' | 'FAIL';

export interface RetryPolicy {
  decide(outcome: AttemptOutcome, failuresIncludingThis: number, maxAttempts: number): RetryDecision;
}

export const defaultRetryPolicy: RetryPolicy = {
  decide(outcome, failures, maxAttempts) {
    if (outcome.kind === 'rejected') return 'REQUEUE';
    if (outcome.kind === 'failed' && !outcome.retryable) return 'FAIL';
    return failures < maxAttempts ? 'REQUEUE' : 'FAIL';
  },
};

/** Outcomes that count against `maxAttempts`. */
export const countsAsFailure = (kind: AttemptOutcome['kind']) => kind !== 'rejected';
