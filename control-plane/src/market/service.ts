// Open platform: providers publish offers for their computers, customers browse them,
// get quotes and submit jobs (JobService). Matching itself is the scheduler's.
import type { AppContext } from '../context.js';
import { audit } from '../audit.js';
import { conflict, notFound } from '../errors.js';
import { createEnrollmentToken } from '../modules/admin/service.js';
import { CreditService } from '../credits/service.js';
import { defaultBudget } from '../credits/service.js';
import { PgSchedulerStore } from '../jobs/scheduler-store.js';
import { ineligibility } from '../scheduler/eligibility.js';
import { scoreWorker } from '../scheduler/strategies/score.js';
import type { JobSpec, Requirements, Resources, WorkerSnapshot } from '../scheduler/types.js';
import {
  maxAttemptCost,
  minutesLeft,
  normalizeOffer,
  priceRate,
  priceView,
  type Offer,
  type OfferInput,
} from './offer.js';
import { loadReputations, type Reputation } from './reputation.js';

/** Unused enrollment tokens one account may hold at a time. */
const MAX_OPEN_ENROLLMENTS = 10;

const credits = (milli: number) => milli / 1000;

/** Public view of an offer: no owner, no usage, no network details. */
function offerView(o: Offer, now: Date) {
  const left = minutesLeft(o.availability, now);
  return {
    listed: o.listed,
    pricePerMinute: priceView(o.price),
    availability: { ...o.availability, availableNow: left > 0, minutesLeftInWindow: Number.isFinite(left) ? left : null },
    limits: o.limits,
  };
}

function hardwareView(h: WorkerSnapshot['hardware']) {
  return {
    os: h.os?.name ?? null,
    cpu: { cores: h.cpu?.cores ?? null, threads: h.cpu?.threads ?? null },
    ramMb: h.ramMb ?? null,
    gpus: (h.gpus ?? []).map((g) => ({ name: g.name ?? null, vendor: g.vendor ?? null, vramMb: g.vramMb ?? null })),
  };
}

function reputationView(r: Reputation | undefined) {
  return r ? { score: r.score, components: r.components, metrics: r.metrics } : null;
}

export class MarketService {
  private readonly store: PgSchedulerStore;

  constructor(private readonly ctx: AppContext) {
    this.store = new PgSchedulerStore(ctx);
  }

  // ---- providers ------------------------------------------------------------------

  /** A one-time token to register a computer; the computer will belong to this account. */
  async enrollmentToken(userId: string, input: { ttlSeconds: number; note?: string | undefined }) {
    const open = await this.ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM enrollment_tokens WHERE created_by = $1 AND used_at IS NULL AND expires_at > now()`,
      [userId],
    );
    if (open.rows[0]!.n >= MAX_OPEN_ENROLLMENTS) throw conflict(`At most ${MAX_OPEN_ENROLLMENTS} unused enrollment tokens`);
    return createEnrollmentToken(this.ctx, input, userId);
  }

  private async ownedWorker(userId: string, workerId: string) {
    const { rows } = await this.ctx.db.query(
      `SELECT w.id, w.name, w.status, w.state, w.last_seen_at, w.hardware, w.capacity, w.workload_types, w.max_concurrent_tasks,
              o.listed, o.price, o.availability, o.limits
         FROM workers w LEFT JOIN worker_offers o ON o.worker_id = w.id
        WHERE w.id = $1 AND w.owner_user_id = $2`,
      [workerId, userId],
    );
    // Someone else's computer answers exactly like a missing one.
    if (!rows[0]) throw notFound('Worker');
    return rows[0];
  }

  private static offerOf(r: Record<string, any>): Offer {
    return normalizeOffer(r.price ? { listed: r.listed, price: r.price, availability: r.availability, limits: r.limits } : null);
  }

  /** The provider's own computers with their offer, reputation and credits. */
  async myWorkers(userId: string) {
    const { rows } = await this.ctx.db.query(
      `SELECT w.id, w.name, w.status, w.state, w.last_seen_at, w.hardware, w.capacity, w.workload_types, w.max_concurrent_tasks,
              o.listed, o.price, o.availability, o.limits,
              (SELECT count(*)::int FROM job_assignments a WHERE a.worker_id = w.id AND a.status IN ('assigned', 'running')) AS active
         FROM workers w LEFT JOIN worker_offers o ON o.worker_id = w.id
        WHERE w.owner_user_id = $1 ORDER BY w.created_at`,
      [userId],
    );
    const reps = await loadReputations(this.ctx.db, rows.map((r) => r.id));
    const credit = new CreditService(this.ctx);
    const now = new Date();
    return {
      items: await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          state: r.state,
          lastSeenAt: r.last_seen_at?.toISOString() ?? null,
          activeAssignments: r.active,
          hardware: hardwareView(r.hardware ?? {}),
          capacity: r.capacity,
          workloadTypes: r.workload_types,
          offer: offerView(MarketService.offerOf(r), now),
          reputation: reputationView(reps.get(r.id)),
          wallet: (await credit.workerWalletView(r.id)).balance,
        })),
      ),
    };
  }

  async getOffer(userId: string, workerId: string) {
    const r = await this.ownedWorker(userId, workerId);
    return offerView(MarketService.offerOf(r), new Date());
  }

  /** Partial update: fields left out keep their value. Takes effect for new assignments only. */
  async setOffer(userId: string, workerId: string, input: OfferInput) {
    const r = await this.ownedWorker(userId, workerId);
    if (r.status !== 'active') throw conflict('Worker is revoked');
    const cur = MarketService.offerOf(r);
    const next: Offer = {
      listed: input.listed ?? cur.listed,
      price: input.price ?? cur.price,
      availability: input.availability ?? cur.availability,
      limits: input.limits ?? cur.limits,
    };
    await this.ctx.db.query(
      `INSERT INTO worker_offers (worker_id, listed, price, availability, limits) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (worker_id) DO UPDATE SET listed = EXCLUDED.listed, price = EXCLUDED.price,
         availability = EXCLUDED.availability, limits = EXCLUDED.limits, updated_at = now()`,
      [workerId, next.listed, next.price, next.availability, next.limits],
    );
    await audit(this.ctx.db, {
      actorType: 'user',
      actorId: userId,
      action: 'worker.offer.update',
      targetType: 'worker',
      targetId: workerId,
      details: { before: cur, after: next },
    });
    await this.ctx.bus.publish('worker.offer', { workerId, listed: next.listed });
    return offerView(next, new Date());
  }

  // ---- customers ------------------------------------------------------------------

  /** Listed, active computers seen recently, with price, terms and objective reputation. */
  async offers(f: { type?: string | undefined; gpu?: boolean | undefined; availableNow?: boolean | undefined; limit: number }) {
    const workers = await this.store.workers();
    const now = new Date();
    const items = workers
      .filter((w) => (w.offer?.listed ?? true) && (!f.type || w.workloadTypes.includes(f.type)))
      .filter((w) => f.gpu === undefined || ((w.capacity?.gpuPercent ?? 0) > 0 && (w.hardware.gpus ?? []).length > 0) === f.gpu)
      .map((w) => {
        const offer = offerView(normalizeOffer(w.offer), now);
        return {
          workerId: w.id,
          name: w.name ?? null,
          state: w.state,
          hardware: hardwareView(w.hardware),
          capacity: w.capacity,
          workloadTypes: w.workloadTypes,
          freeSlots: Math.max(0, w.maxConcurrent - w.activeAssignments),
          calibrated: !!w.performance,
          cpuScore: w.performance?.cpuScore ?? null,
          offer,
          reputation: reputationView(w.reputation),
        };
      })
      .filter((o) => !f.availableNow || o.offer.availability.availableNow)
      // Deterministic order: reputation, then price per CPU core, then id.
      .sort(
        (a, b) =>
          (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0) ||
          a.offer.pricePerMinute.cpuCore - b.offer.pricePerMinute.cpuCore ||
          (a.workerId < b.workerId ? -1 : 1),
      );
    return { items: items.slice(0, f.limit), total: items.length };
  }

  async reputation(workerId: string) {
    const { rows } = await this.ctx.db.query(`SELECT id, name FROM workers WHERE id = $1 AND status = 'active'`, [workerId]);
    if (!rows[0]) throw notFound('Worker');
    const r = (await loadReputations(this.ctx.db, [workerId])).get(workerId)!;
    return { workerId, name: rows[0].name, ...r, sources: 'server-observed only: attempts, heartbeats, accept times' };
  }

  /**
   * What a job would cost and where it could run, using the scheduler's own rules
   * (eligibility + score). Nothing is reserved or created.
   */
  async quote(ownerId: string, q: {
    type: string;
    requirements: Requirements;
    resources: Resources;
    timeout: number;
    priority: number;
    budget?: number | undefined;
  }) {
    const budget = q.budget ?? defaultBudget(q.resources, q.timeout);
    const job: JobSpec = {
      id: '00000000-0000-0000-0000-000000000000',
      type: q.type,
      priority: q.priority,
      requirements: q.requirements,
      resources: q.resources,
      createdAt: new Date(),
      excludedWorkers: [],
      timeoutSeconds: q.timeout,
      ownerId,
      budgetRemaining: budget,
    };
    const now = new Date();
    const o = { now, offlineAfterMs: this.ctx.config.WORKER_OFFLINE_AFTER_SECONDS * 1000, thermalMarginC: this.ctx.config.THERMAL_MARGIN_C };
    const workers = (await this.store.workers()).filter((w) => w.offer?.listed ?? true);
    const rows = workers.map((w) => {
      const rate = priceRate(normalizeOffer(w.offer).price, q.resources);
      const why = ineligibility(job, w, o);
      return {
        workerId: w.id,
        name: w.name ?? null,
        eligible: why === null,
        reason: why,
        pricePerMinute: credits(rate),
        maxCost: credits(maxAttemptCost(rate, q.timeout)),
        reputation: w.reputation?.score ?? null,
        score: why === null ? scoreWorker(job, w, o).total : null,
      };
    });
    rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? 0) - (a.score ?? 0) || (a.workerId < b.workerId ? -1 : 1));
    const eligible = rows.filter((r) => r.eligible);
    return {
      budget: credits(budget),
      budgetDefaulted: q.budget === undefined,
      eligible: eligible.length,
      bestMatch: eligible[0] ?? null,
      cheapestMaxCost: eligible.length ? Math.min(...eligible.map((r) => r.maxCost)) : null,
      candidates: rows.slice(0, 50),
    };
  }
}
