// One scheduling pass: monitor what is running, then place what is queued.
import { describeUnplaced, ineligibility, reserve, trustedOnline, type EligibilityOptions } from './eligibility.js';
import type { SchedulerMonitors, SchedulerStore } from './ports.js';
import type { PlacementStrategy } from './strategy.js';
import type { JobSpec, WorkerSnapshot } from './types.js';

export interface EngineOptions {
  batchSize: number;
  offlineAfterMs: number;
  thermalMarginC: number;
  reconcileEveryTicks: number;
  now?: () => Date;
}

export interface TickReport {
  offline: number;
  expired: number;
  stale: number;
  timedOut: number;
  reconciled?: number;
  considered: number;
  assigned: number;
  unplaced: number;
  /** Placements the strategy proposed that failed the engine's own checks. */
  rejectedPlacements: number;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class SchedulerEngine {
  private ticks = 0;

  constructor(
    private readonly store: SchedulerStore,
    private readonly monitors: SchedulerMonitors,
    private readonly strategy: PlacementStrategy,
    private readonly opts: EngineOptions,
    private readonly log?: Logger,
  ) {}

  get strategyName() {
    return this.strategy.name;
  }

  async tick(): Promise<TickReport> {
    const r: TickReport = {
      offline: 0,
      expired: 0,
      stale: 0,
      timedOut: 0,
      considered: 0,
      assigned: 0,
      unplaced: 0,
      rejectedPlacements: 0,
    };
    if (this.ticks++ % this.opts.reconcileEveryTicks === 0) r.reconciled = await this.monitors.reconcile();

    // 6–9: heartbeat, timeout and failure monitoring; re-routing happens inside via the retry policy.
    r.offline = await this.monitors.detectOfflineWorkers();
    r.timedOut = await this.monitors.enforceTimeouts();
    r.expired = await this.monitors.expireUnaccepted();
    r.stale = await this.monitors.reclaimStale();

    // 1–5: receive, analyse, find compatible workers, select, send.
    const jobs = await this.store.queuedJobs(this.opts.batchSize);
    r.considered = jobs.length;
    if (jobs.length > 0) {
      const workers = await this.store.workers();
      const eo: EligibilityOptions = {
        now: this.opts.now?.() ?? new Date(),
        offlineAfterMs: this.opts.offlineAfterMs,
        thermalMarginC: this.opts.thermalMarginC,
      };
      eo.trustedOnline = trustedOnline(workers, eo);
      const result = this.strategy.place(jobs, workers, eo);
      const byJob = new Map<string, JobSpec>(jobs.map((j) => [j.id, j]));
      const pool = new Map<string, WorkerSnapshot>(workers.map((w) => [w.id, w]));
      const placed = new Set<string>();

      for (const p of result.placements) {
        const job = byJob.get(p.jobId);
        const w = pool.get(p.workerId);
        // Never trust the strategy blindly: re-check hard constraints with reservations so far.
        const why = !job || !w || placed.has(p.jobId) ? 'UNKNOWN' : ineligibility(job, w, eo);
        if (why) {
          r.rejectedPlacements++;
          this.log?.warn({ placement: p, why, strategy: this.strategy.name }, 'strategy proposed an invalid placement');
          continue;
        }
        if (await this.store.assign(p, this.strategy.name, job!)) {
          placed.add(p.jobId);
          pool.set(w!.id, reserve(w!, job!.resources));
          r.assigned++;
        }
      }
      for (const u of result.unplaced) {
        await this.store.setPendingReason(u.jobId, describeUnplaced(u.reasons, workers.length));
      }
      r.unplaced = result.unplaced.length;
    }

    if (r.assigned || r.offline || r.expired || r.stale || r.timedOut || r.rejectedPlacements)
      this.log?.info({ report: r }, 'scheduler pass');
    return r;
  }
}
