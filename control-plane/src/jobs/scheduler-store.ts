// Postgres/Redis implementation of the scheduler ports.
import { toPerformanceView } from '../performance/service.js';
import type { AppContext } from '../context.js';
import type { JobSpec, Placement, SchedulerMonitors, SchedulerStore, WorkerSnapshot } from '../scheduler/index.js';
import { JobLifecycle } from './lifecycle.js';
import { WorkerService } from '../modules/workers/service.js';

/** A worker that declined or timed out on a job is skipped for this long; failures are permanent per job. */
const SHORT_EXCLUSION_SECONDS = 60;

export class PgSchedulerStore implements SchedulerStore, SchedulerMonitors {
  private readonly lifecycle: JobLifecycle;
  private readonly workersSvc: WorkerService;

  constructor(private readonly ctx: AppContext) {
    this.lifecycle = new JobLifecycle(ctx);
    this.workersSvc = new WorkerService(ctx);
  }

  async queuedJobs(limit: number): Promise<JobSpec[]> {
    const ids = await this.ctx.queue.peek(limit);
    if (ids.length === 0) return [];
    const { rows } = await this.ctx.db.query(
      `SELECT j.id, j.type, j.priority, j.requirements, j.resources, j.created_at, j.timeout_seconds,
              COALESCE(x.workers, '{}') AS excluded,
              CASE WHEN j.type = 'image-inference' THEN jsonb_build_object(
                'items', jsonb_array_length(j.input->'images'),
                'bytes', (SELECT COALESCE(sum((i->>'size')::bigint), 0) FROM jsonb_array_elements(j.input->'images') i),
                'accelerator', COALESCE(j.input->>'accelerator', 'auto')) END AS work
         FROM jobs j
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT a.worker_id) AS workers FROM job_assignments a
            WHERE a.job_id = j.id
              AND (a.status IN ('failed', 'lost', 'timeout')
                   OR (a.status IN ('rejected', 'expired') AND a.finished_at > now() - make_interval(secs => $2)))
         ) x ON true
        WHERE j.id = ANY($1::uuid[]) AND j.status = 'QUEUED'
        ORDER BY j.priority DESC, j.created_at, j.id`,
      [ids, SHORT_EXCLUSION_SECONDS],
    );
    // Stale index entries (job no longer queued) are dropped here.
    const found = new Set(rows.map((r) => r.id));
    const stale = ids.filter((id) => !found.has(id));
    if (stale.length) await this.ctx.queue.remove(stale);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      priority: r.priority,
      requirements: r.requirements,
      resources: r.resources,
      createdAt: r.created_at,
      excludedWorkers: r.excluded,
      timeoutSeconds: r.timeout_seconds,
      ...(r.work ? { work: { items: r.work.items, bytes: Number(r.work.bytes), accelerator: r.work.accelerator } } : {}),
    }));
  }

  async workers(): Promise<WorkerSnapshot[]> {
    const { rows } = await this.ctx.db.query(
      `SELECT w.id, w.state, w.last_seen_at, w.max_concurrent_tasks, w.workload_types, w.hardware, w.capacity, w.last_usage,
              r.n, r.cpu, r.ram, r.gpu, r.vram, r.disk, h.completed, h.failed,
              p.profile, p.verified, p.observed
         FROM workers w
         LEFT JOIN worker_performance p ON p.worker_id = w.id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS n,
                  COALESCE(sum((a.reserved->>'cpuCores')::float), 0) AS cpu,
                  COALESCE(sum((a.reserved->>'ramMb')::int), 0)::int AS ram,
                  COALESCE(bool_or((a.reserved->>'gpu')::boolean), false) AS gpu,
                  COALESCE(sum((a.reserved->>'vramMb')::int), 0)::int AS vram,
                  COALESCE(sum((a.reserved->>'diskMb')::int), 0)::int AS disk
             FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('assigned', 'running')
         ) r ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE status IN ('failed', 'lost', 'expired', 'timeout'))::int AS failed
             FROM (SELECT status FROM job_assignments
                    WHERE worker_id = w.id AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 20) recent
         ) h ON true
        WHERE w.status = 'active' AND w.state <> 'offline'`,
    );
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      lastSeenAt: r.last_seen_at,
      maxConcurrent: r.max_concurrent_tasks,
      workloadTypes: r.workload_types,
      hardware: r.hardware ?? {},
      capacity: r.capacity,
      usage: r.last_usage,
      reserved: { cpuCores: r.cpu, ramMb: r.ram, gpu: r.gpu, vramMb: r.vram, diskMb: r.disk },
      activeAssignments: r.n,
      recent: { completed: r.completed, failed: r.failed },
      performance: toPerformanceView(r.profile, r.verified, r.observed),
    }));
  }

  async assign(p: Placement, strategy: string, job: JobSpec): Promise<boolean> {
    return (await this.lifecycle.assign(p, strategy, job.resources)) !== null;
  }

  setPendingReason(jobId: string, reason: string | null) {
    return this.lifecycle.setPendingReason(jobId, reason);
  }

  async detectOfflineWorkers() {
    return (await this.workersSvc.detectOffline()).length;
  }
  expireUnaccepted() {
    return this.lifecycle.expireUnaccepted();
  }
  reclaimStale() {
    return this.lifecycle.reclaimStale();
  }
  enforceTimeouts() {
    return this.lifecycle.enforceTimeouts();
  }
  reconcile() {
    return this.ctx.queue.reconcile(this.ctx.db);
  }
}
