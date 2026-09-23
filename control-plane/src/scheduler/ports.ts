// What the scheduler engine needs from the outside world. Postgres/Redis adapters
// implement this in src/jobs/scheduler-store.ts; tests use in-memory fakes.
import type { JobSpec, Placement, WorkerSnapshot } from './types.js';

export interface SchedulerStore {
  /** Highest priority first, then oldest. */
  queuedJobs(limit: number): Promise<JobSpec[]>;
  /** Active workers with their current reservations. */
  workers(): Promise<WorkerSnapshot[]>;
  /** Persists and dispatches a placement. False if the job/worker changed meanwhile. */
  assign(p: Placement, strategy: string, job: JobSpec): Promise<boolean>;
  /** Explains why a job is still queued (null clears it). */
  setPendingReason(jobId: string, reason: string | null): Promise<void>;
}

export interface SchedulerMonitors {
  /** Workers without heartbeat → offline; their attempts are lost and re-routed. */
  detectOfflineWorkers(): Promise<number>;
  /** Assignments not accepted in time. */
  expireUnaccepted(): Promise<number>;
  /** Running assignments the worker stopped reporting. */
  reclaimStale(): Promise<number>;
  /** Attempts running longer than the job's timeout. */
  enforceTimeouts(): Promise<number>;
  /** Periodic consistency repair (e.g. rebuild the queue index). */
  reconcile(): Promise<number>;
}
