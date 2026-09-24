// Business rules on top of the ledger: grants, job holds and settlement, worker
// earnings, withdrawals to the worker's owner, and read models (all derived).
import type pg from 'pg';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { audit } from '../audit.js';
import { conflict, forbidden, notFound } from '../errors.js';
import type { Resources } from '../scheduler/types.js';
import { GENESIS_HASH, Ledger, insufficientCredits, txHash, withEntries, type LedgerTx } from './ledger.js';
import { attemptCharge, computeEarning, holdAmount, MILLI, ratePerMinute, toCredits } from './pricing.js';

export interface CreditActor {
  userId: string;
  role: 'admin' | 'operator' | 'viewer';
}

const credits = (milli: number) => ({ milli, credits: toCredits(milli) });

/** Idempotent replays return the original transaction; a reused key with other content is refused. */
function replay(existing: LedgerTx, same: (t: LedgerTx) => boolean) {
  if (!same(existing)) throw conflict('Idempotency key already used for a different operation');
  return existing;
}

// ---- in-transaction hooks (called by jobs / users code, inside their own transaction) ----

/** Welcome grant for a new user (config CREDITS_INITIAL_GRANT). */
export async function grantSignup(ctx: AppContext, c: pg.PoolClient, userId: string) {
  const amount = ctx.config.CREDITS_INITIAL_GRANT * MILLI;
  const ledger = new Ledger(c);
  const wallet = await ledger.userWallet(userId);
  if (amount <= 0) return;
  await ledger.post([
    {
      kind: 'grant',
      idempotencyKey: `signup:user:${userId}`,
      entries: [
        { walletId: await ledger.systemWallet('issuance'), amount: -amount },
        { walletId: wallet, amount },
      ],
      actorType: 'system',
      memo: 'Créditos iniciais',
      detail: { reason: 'signup' },
    },
  ]);
}

export interface HoldRequest {
  jobId: string;
  resources: Resources;
  timeoutSeconds: number;
}

/**
 * Reserves the maximum cost of each job (rate × timeout) from the owner's wallet into
 * escrow. All or nothing: not enough credits for every job → nothing is created.
 */
export async function holdForJobs(c: pg.PoolClient, ownerId: string, jobs: HoldRequest[]) {
  if (jobs.length === 0) return;
  const ledger = new Ledger(c);
  await ledger.lock();
  const wallet = await ledger.userWallet(ownerId);
  const escrow = await ledger.systemWallet('escrow');
  const amounts = jobs.map((j) => holdAmount(j.resources, j.timeoutSeconds));
  const total = amounts.reduce((s, a) => s + a, 0);
  const available = await ledger.balance(wallet);
  if (total > available) throw insufficientCredits(total, available);
  await ledger.post(
    jobs.map((j, i) => ({
      kind: 'hold' as const,
      idempotencyKey: `hold:job:${j.jobId}`,
      jobId: j.jobId,
      entries: [
        { walletId: wallet, amount: -amounts[i]! },
        { walletId: escrow, amount: amounts[i]! },
      ],
      actorType: 'user' as const,
      actorId: ownerId,
      memo: 'Reserva para execução do job',
      detail: {
        ratePerMinute: ratePerMinute(j.resources),
        timeoutSeconds: j.timeoutSeconds,
        resources: j.resources,
        formula: 'ceil(ratePerMinute × timeoutSeconds / 60)',
      },
    })),
  );
}

/**
 * Pays the worker for a productive attempt (completed, or a resumable attempt that
 * timed out with its checkpoint kept). Caller has just set finished_at.
 */
export async function earnForAssignment(c: pg.PoolClient, assignmentId: string) {
  const { rows } = await c.query<{
    worker_id: string;
    job_id: string;
    name: string;
    seconds: number | null;
    reserved: Resources;
    profile: { scores?: { cpu?: number; gpu?: number } } | null;
    verified: boolean | null;
    online_minutes: number;
  }>(
    `SELECT a.worker_id, a.job_id, w.name, a.reserved,
            EXTRACT(EPOCH FROM (a.finished_at - a.started_at))::float8 AS seconds,
            p.profile, p.verified,
            (SELECT count(*)::int FROM worker_metrics m
              WHERE m.worker_id = a.worker_id AND m.ts > now() - interval '24 hours'
                AND m.state IN ('available', 'running')) AS online_minutes
       FROM job_assignments a
       JOIN workers w ON w.id = a.worker_id
       LEFT JOIN worker_performance p ON p.worker_id = a.worker_id
      WHERE a.id = $1`,
    [assignmentId],
  );
  const r = rows[0];
  if (!r || r.seconds === null) return null;
  const score = (r.reserved.gpu ? r.profile?.scores?.gpu : r.profile?.scores?.cpu) ?? null;
  const e = computeEarning({
    workerName: r.name,
    seconds: r.seconds,
    resources: r.reserved,
    performance: { verified: r.verified === true, score },
    onlineMinutes: r.online_minutes,
  });
  if (e.amount <= 0) return null;
  const ledger = new Ledger(c);
  await ledger.lock();
  const key = `earning:assignment:${assignmentId}`;
  if (await ledger.findByKey(key)) return null;
  const [tx] = await ledger.post([
    {
      kind: 'earning',
      idempotencyKey: key,
      jobId: r.job_id,
      assignmentId,
      workerId: r.worker_id,
      entries: [
        { walletId: await ledger.systemWallet('issuance'), amount: -e.amount },
        { walletId: await ledger.workerWallet(r.worker_id), amount: e.amount },
      ],
      actorType: 'system',
      memo: e.detail.summary,
      detail: e.detail,
    },
  ]);
  return tx!;
}

/**
 * Closes a job's hold when it reaches a terminal state. COMPLETED: the owner pays the
 * compute time of its productive attempts (per second, capped at the hold); anything
 * else: full refund. Runs once per job (idempotency key).
 */
export async function settleJob(c: pg.PoolClient, jobId: string) {
  const ledger = new Ledger(c);
  await ledger.lock();
  const key = `settlement:job:${jobId}`;
  if (await ledger.findByKey(key)) return null;
  const escrow = await ledger.systemWallet('escrow');
  const held = Number(
    (
      await c.query<{ h: string }>(
        `SELECT COALESCE(sum(e.amount), 0)::text AS h
           FROM credit_entries e JOIN credit_transactions t ON t.id = e.transaction_id
          WHERE t.job_id = $1 AND e.wallet_id = $2`,
        [jobId, escrow],
      )
    ).rows[0]!.h,
  );
  if (held <= 0) return null; // no hold (job created before credits existed)
  const job = (
    await c.query<{ owner_id: string; status: string; resources: Resources; retry_on_timeout: boolean }>(
      `SELECT owner_id, status, resources, retry_on_timeout FROM jobs WHERE id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!job) return null;
  const rate = ratePerMinute(job.resources);
  const attempts =
    job.status === 'COMPLETED'
      ? (
          await c.query<{ id: string; status: string; seconds: number }>(
            `SELECT id, status, EXTRACT(EPOCH FROM (finished_at - started_at))::float8 AS seconds
               FROM job_assignments
              WHERE job_id = $1 AND started_at IS NOT NULL AND finished_at IS NOT NULL
                AND (status = 'completed' OR (status = 'timeout' AND $2))
              ORDER BY attempt`,
            [jobId, job.retry_on_timeout],
          )
        ).rows
      : [];
  const billed = attempts.map((a) => ({
    assignmentId: a.id,
    status: a.status,
    seconds: Math.round(a.seconds * 1000) / 1000,
    charge: attemptCharge(rate, a.seconds),
  }));
  const raw = billed.reduce((s, a) => s + a.charge, 0);
  const cost = Math.min(raw, held);
  const refund = held - cost;
  const user = await ledger.userWallet(job.owner_id);
  const entries = [{ walletId: escrow, amount: -held }];
  if (cost > 0) entries.push({ walletId: await ledger.systemWallet('consumption'), amount: cost });
  if (refund > 0) entries.push({ walletId: user, amount: refund });
  const memo =
    job.status === 'COMPLETED'
      ? `Job concluído: ${toCredits(cost)} créditos cobrados, ${toCredits(refund)} devolvidos`
      : `Job ${job.status}: reserva de ${toCredits(held)} créditos devolvida`;
  const [tx] = await ledger.post([
    {
      kind: 'settlement',
      idempotencyKey: key,
      jobId,
      entries,
      actorType: 'system',
      memo,
      detail: {
        jobStatus: job.status,
        ratePerMinute: rate,
        held,
        charged: cost,
        refunded: refund,
        cappedAtHold: raw > held,
        attempts: billed,
        formula: 'Σ ceil(ratePerMinute × ceil(seconds) / 60) over productive attempts, ≤ held',
      },
    },
  ]);
  return tx!;
}

// ---- API ------------------------------------------------------------------------------

interface WalletRow {
  id: string;
  kind: string;
  user_id: string | null;
  worker_id: string | null;
  system_name: string | null;
  balance: string;
}

export class CreditService {
  constructor(private readonly ctx: AppContext) {}

  /** Admin: give credits to a user (virtual, internal). */
  async grant(actor: CreditActor, input: { userId: string; amount: number; reason: string; idempotencyKey: string }) {
    const key = `grant:${input.idempotencyKey}`;
    const res = await withTx(this.ctx.db, async (c) => {
      const u = await c.query(`SELECT 1 FROM users WHERE id = $1`, [input.userId]);
      if (!u.rows[0]) throw notFound('User');
      const ledger = new Ledger(c);
      await ledger.lock();
      const wallet = await ledger.userWallet(input.userId);
      const existing = await ledger.findByKey(key);
      if (existing)
        return {
          tx: replay(existing, (t) => t.kind === 'grant' && t.entries.some((e) => e.walletId === wallet && e.amount === input.amount)),
          replayed: true,
        };
      const [tx] = await ledger.post([
        {
          kind: 'grant',
          idempotencyKey: key,
          entries: [
            { walletId: await ledger.systemWallet('issuance'), amount: -input.amount },
            { walletId: wallet, amount: input.amount },
          ],
          actorType: 'user',
          actorId: actor.userId,
          memo: input.reason,
          detail: { reason: input.reason },
        },
      ]);
      await audit(c, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'credits.grant',
        targetType: 'user',
        targetId: input.userId,
        details: { amount: input.amount, transactionId: tx!.id },
      });
      return { tx: tx!, replayed: false };
    });
    return { transaction: this.txView(res.tx), replayed: res.replayed };
  }

  /** Moves a worker's earnings to its owner's wallet (the only way credits leave a worker wallet). */
  async withdraw(actor: CreditActor, workerId: string, input: { amount: number; idempotencyKey: string }) {
    const key = `withdrawal:${workerId}:${input.idempotencyKey}`;
    const res = await withTx(this.ctx.db, async (c) => {
      const w = (await c.query<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM workers WHERE id = $1`, [workerId]))
        .rows[0];
      if (!w || (w.owner_user_id !== actor.userId && actor.role !== 'admin')) throw notFound('Worker');
      if (!w.owner_user_id) throw conflict('Worker has no owner to withdraw to');
      if (w.owner_user_id !== actor.userId) throw forbidden('Only the worker owner can withdraw its credits');
      const ledger = new Ledger(c);
      await ledger.lock();
      const from = await ledger.workerWallet(workerId);
      const to = await ledger.userWallet(w.owner_user_id);
      const existing = await ledger.findByKey(key);
      if (existing)
        return {
          tx: replay(existing, (t) => t.kind === 'withdrawal' && t.entries.some((e) => e.walletId === from && e.amount === -input.amount)),
          replayed: true,
        };
      const [tx] = await ledger.post([
        {
          kind: 'withdrawal',
          idempotencyKey: key,
          workerId,
          entries: [
            { walletId: from, amount: -input.amount },
            { walletId: to, amount: input.amount },
          ],
          actorType: 'user',
          actorId: actor.userId,
          memo: 'Transferência dos ganhos do worker para o dono',
        },
      ]);
      await audit(c, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'credits.withdraw',
        targetType: 'worker',
        targetId: workerId,
        details: { amount: input.amount, transactionId: tx!.id },
      });
      return { tx: tx!, replayed: false };
    });
    return { transaction: this.txView(res.tx), replayed: res.replayed };
  }

  // ---- read models ----------------------------------------------------------------------

  private async walletRow(where: string, arg: string): Promise<WalletRow | null> {
    const { rows } = await this.ctx.db.query<WalletRow>(
      `SELECT w.id, w.kind, w.user_id, w.worker_id, w.system_name,
              COALESCE((SELECT sum(amount) FROM credit_entries e WHERE e.wallet_id = w.id), 0)::text AS balance
         FROM credit_wallets w WHERE ${where}`,
      [arg],
    );
    return rows[0] ?? null;
  }

  /** Caller's wallet: balance (derived), open holds, totals by kind. */
  async userWallet(userId: string) {
    const w = await this.walletRow('w.user_id = $1', userId);
    const held = await this.ctx.db.query<{ h: string }>(
      `SELECT COALESCE(sum(e.amount), 0)::text AS h
         FROM credit_entries e
         JOIN credit_transactions t ON t.id = e.transaction_id
         JOIN credit_wallets x ON x.id = e.wallet_id AND x.system_name = 'escrow'
         JOIN jobs j ON j.id = t.job_id
        WHERE j.owner_id = $1`,
      [userId],
    );
    return {
      walletId: w?.id ?? null,
      owner: { type: 'user', id: userId },
      balance: credits(Number(w?.balance ?? 0)),
      held: credits(Number(held.rows[0]!.h)),
      totals: w ? await this.totals(w.id) : {},
    };
  }

  async workerWallet(actor: CreditActor, workerId: string) {
    await this.assertWorkerVisible(actor, workerId);
    return this.workerWalletView(workerId);
  }

  /** Also used by the worker's own stats endpoint. */
  async workerWalletView(workerId: string) {
    const w = await this.walletRow('w.worker_id = $1', workerId);
    return {
      walletId: w?.id ?? null,
      owner: { type: 'worker', id: workerId },
      balance: credits(Number(w?.balance ?? 0)),
      totals: w ? await this.totals(w.id) : {},
    };
  }

  private async totals(walletId: string) {
    const { rows } = await this.ctx.db.query<{ kind: string; inflow: string; outflow: string }>(
      `SELECT t.kind,
              COALESCE(sum(e.amount) FILTER (WHERE e.amount > 0), 0)::text AS inflow,
              COALESCE(-sum(e.amount) FILTER (WHERE e.amount < 0), 0)::text AS outflow
         FROM credit_entries e JOIN credit_transactions t ON t.id = e.transaction_id
        WHERE e.wallet_id = $1 GROUP BY t.kind ORDER BY t.kind`,
      [walletId],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, { in: credits(Number(r.inflow)), out: credits(Number(r.outflow)) }]));
  }

  /** Movements of one wallet, newest first, each with the balance right after it (derived). */
  async transactions(walletId: string | null, f: { limit: number; beforeSeq?: number | undefined; kind?: string | undefined }) {
    if (!walletId) return { items: [], nextCursor: null };
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM (
         SELECT t.*, e.amount::text AS delta,
                (sum(e.amount) OVER (ORDER BY t.seq ROWS UNBOUNDED PRECEDING))::text AS balance_after
           FROM credit_entries e JOIN credit_transactions t ON t.id = e.transaction_id
          WHERE e.wallet_id = $1) x
        WHERE ($2::bigint IS NULL OR x.seq < $2) AND ($3::text IS NULL OR x.kind = $3)
        ORDER BY x.seq DESC LIMIT $4`,
      [walletId, f.beforeSeq ?? null, f.kind ?? null, f.limit + 1],
    );
    const page = rows.slice(0, f.limit);
    return {
      items: page.map((r) => ({
        seq: Number(r.seq),
        id: r.id,
        kind: r.kind,
        amount: credits(Number(r.delta)),
        balanceAfter: credits(Number(r.balance_after)),
        memo: r.memo,
        jobId: r.job_id,
        assignmentId: r.assignment_id,
        workerId: r.worker_id,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
        hash: r.hash,
      })),
      nextCursor: rows.length > f.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  async userTransactions(userId: string, f: { limit: number; beforeSeq?: number | undefined; kind?: string | undefined }) {
    const w = await this.walletRow('w.user_id = $1', userId);
    return this.transactions(w?.id ?? null, f);
  }

  async workerTransactions(actor: CreditActor, workerId: string, f: { limit: number; beforeSeq?: number | undefined }) {
    await this.assertWorkerVisible(actor, workerId);
    const w = await this.walletRow('w.worker_id = $1', workerId);
    return this.transactions(w?.id ?? null, f);
  }

  /** Earnings of the caller's workers (admins: any worker), with the calculation of each. */
  async earnings(actor: CreditActor, f: { workerId?: string | undefined; limit: number; beforeSeq?: number | undefined }) {
    if (f.workerId) await this.assertWorkerVisible(actor, f.workerId);
    const scope = actor.role === 'admin' ? null : actor.userId;
    const { rows } = await this.ctx.db.query(
      `SELECT t.seq, t.id, t.job_id, t.assignment_id, t.worker_id, w.name AS worker_name, t.memo, t.detail, t.created_at,
              e.amount::text AS amount
         FROM credit_transactions t
         JOIN credit_entries e ON e.transaction_id = t.id
         JOIN credit_wallets cw ON cw.id = e.wallet_id AND cw.worker_id = t.worker_id
         JOIN workers w ON w.id = t.worker_id
        WHERE t.kind = 'earning'
          AND ($1::uuid IS NULL OR w.owner_user_id = $1)
          AND ($2::uuid IS NULL OR t.worker_id = $2)
          AND ($3::bigint IS NULL OR t.seq < $3)
        ORDER BY t.seq DESC LIMIT $4`,
      [scope, f.workerId ?? null, f.beforeSeq ?? null, f.limit + 1],
    );
    const totals = await this.ctx.db.query<{ worker_id: string; name: string; n: number; total: string }>(
      `SELECT t.worker_id, w.name, count(*)::int AS n, sum(e.amount)::text AS total
         FROM credit_transactions t
         JOIN credit_entries e ON e.transaction_id = t.id
         JOIN credit_wallets cw ON cw.id = e.wallet_id AND cw.worker_id = t.worker_id
         JOIN workers w ON w.id = t.worker_id
        WHERE t.kind = 'earning' AND ($1::uuid IS NULL OR w.owner_user_id = $1) AND ($2::uuid IS NULL OR t.worker_id = $2)
        GROUP BY t.worker_id, w.name ORDER BY w.name`,
      [scope, f.workerId ?? null],
    );
    const page = rows.slice(0, f.limit);
    return {
      byWorker: totals.rows.map((r) => ({ workerId: r.worker_id, name: r.name, earnings: r.n, total: credits(Number(r.total)) })),
      items: page.map((r) => ({
        seq: Number(r.seq),
        id: r.id,
        workerId: r.worker_id,
        workerName: r.worker_name,
        jobId: r.job_id,
        assignmentId: r.assignment_id,
        amount: credits(Number(r.amount)),
        summary: r.memo,
        calculation: r.detail,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > f.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  /** What the caller's jobs cost: one row per job with hold, charge and refund. */
  async spending(userId: string, f: { limit: number; beforeSeq?: number | undefined }) {
    const { rows } = await this.ctx.db.query(
      `SELECT h.seq, h.job_id, j.name, j.type, j.status, h.created_at AS held_at,
              (h.detail->>'ratePerMinute')::int AS rate,
              he.amount::text AS held, s.id AS settlement_id, s.detail AS settlement, s.created_at AS settled_at
         FROM credit_transactions h
         JOIN credit_entries he ON he.transaction_id = h.id AND he.amount > 0
         JOIN jobs j ON j.id = h.job_id
         LEFT JOIN credit_transactions s ON s.idempotency_key = 'settlement:job:' || h.job_id
        WHERE h.kind = 'hold' AND j.owner_id = $1 AND ($2::bigint IS NULL OR h.seq < $2)
        ORDER BY h.seq DESC LIMIT $3`,
      [userId, f.beforeSeq ?? null, f.limit + 1],
    );
    const totals = await this.ctx.db.query<{ charged: string; held: string }>(
      `SELECT COALESCE(sum((s.detail->>'charged')::bigint), 0)::text AS charged,
              COALESCE(sum(he.amount) FILTER (WHERE s.id IS NULL), 0)::text AS held
         FROM credit_transactions h
         JOIN credit_entries he ON he.transaction_id = h.id AND he.amount > 0
         JOIN jobs j ON j.id = h.job_id
         LEFT JOIN credit_transactions s ON s.idempotency_key = 'settlement:job:' || h.job_id
        WHERE h.kind = 'hold' AND j.owner_id = $1`,
      [userId],
    );
    const page = rows.slice(0, f.limit);
    return {
      totals: { charged: credits(Number(totals.rows[0]!.charged)), held: credits(Number(totals.rows[0]!.held)) },
      items: page.map((r) => ({
        seq: Number(r.seq),
        jobId: r.job_id,
        jobName: r.name,
        type: r.type,
        jobStatus: r.status,
        ratePerMinute: credits(r.rate),
        held: credits(Number(r.held)),
        state: r.settlement_id ? 'settled' : 'held',
        charged: r.settlement ? credits(Number(r.settlement.charged)) : null,
        refunded: r.settlement ? credits(Number(r.settlement.refunded)) : null,
        attempts: r.settlement?.attempts ?? [],
        heldAt: r.held_at.toISOString(),
        settledAt: r.settled_at?.toISOString() ?? null,
      })),
      nextCursor: rows.length > f.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  /** Admin: the raw ledger, in order, with entries and hashes. */
  async ledger(f: { afterSeq: number; limit: number; jobId?: string | undefined; kind?: string | undefined }) {
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM credit_transactions
        WHERE seq > $1 AND ($2::uuid IS NULL OR job_id = $2) AND ($3::text IS NULL OR kind = $3)
        ORDER BY seq LIMIT $4`,
      [f.afterSeq, f.jobId ?? null, f.kind ?? null, f.limit + 1],
    );
    const page = await withEntries(this.ctx.db, rows.slice(0, f.limit));
    const wallets = await this.walletLabels(page.flatMap((t) => t.entries.map((e) => e.walletId)));
    return {
      items: page.map((t) => ({
        ...this.txView(t),
        entries: t.entries.map((e) => ({ wallet: wallets.get(e.walletId), amount: credits(e.amount) })),
      })),
      nextCursor: rows.length > f.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  /** Admin: system wallets and the global invariants. */
  async summary() {
    const { rows } = await this.ctx.db.query<{ system_name: string; balance: string }>(
      `SELECT w.system_name, COALESCE(sum(e.amount), 0)::text AS balance
         FROM credit_wallets w LEFT JOIN credit_entries e ON e.wallet_id = w.id
        WHERE w.kind = 'system' GROUP BY w.system_name`,
    );
    const sys = Object.fromEntries(rows.map((r) => [r.system_name, Number(r.balance)]));
    const byKind = await this.ctx.db.query<{ kind: string; n: number; b: string }>(
      `SELECT w.kind, count(DISTINCT w.id)::int AS n, COALESCE(sum(e.amount), 0)::text AS b
         FROM credit_wallets w LEFT JOIN credit_entries e ON e.wallet_id = w.id
        WHERE w.kind <> 'system' GROUP BY w.kind`,
    );
    return {
      issued: credits(-(sys.issuance ?? 0)),
      inEscrow: credits(sys.escrow ?? 0),
      consumed: credits(sys.consumption ?? 0),
      wallets: Object.fromEntries(byKind.rows.map((r) => [r.kind, { count: r.n, balance: credits(Number(r.b)) }])),
    };
  }

  /**
   * Admin: recomputes everything from the ledger — hash chain, per-transaction balance,
   * no negative wallet, escrow = open holds. Read-only; safe to run any time.
   */
  async verify() {
    const problems: string[] = [];
    let prev = GENESIS_HASH;
    let count = 0;
    let after = 0;
    for (;;) {
      const { rows } = await this.ctx.db.query(`SELECT * FROM credit_transactions WHERE seq > $1 ORDER BY seq LIMIT 1000`, [after]);
      if (rows.length === 0) break;
      for (const t of await withEntries(this.ctx.db, rows)) {
        count++;
        after = t.seq;
        if (t.prevHash !== prev) problems.push(`seq ${t.seq}: prev_hash does not match the previous transaction`);
        if (txHash(t.prevHash, t) !== t.hash) problems.push(`seq ${t.seq}: hash does not match its content`);
        const sum = t.entries.reduce((s, e) => s + e.amount, 0);
        if (sum !== 0 || t.entries.length < 2) problems.push(`seq ${t.seq}: unbalanced (${sum})`);
        prev = t.hash;
      }
    }
    const neg = await this.ctx.db.query<{ id: string; b: string }>(
      `SELECT w.id, sum(e.amount)::text AS b FROM credit_wallets w JOIN credit_entries e ON e.wallet_id = w.id
        WHERE NOT w.allow_negative GROUP BY w.id HAVING sum(e.amount) < 0`,
    );
    for (const r of neg.rows) problems.push(`wallet ${r.id} is negative (${r.b})`);
    const escrow = await this.ctx.db.query<{ open: string; bal: string }>(
      `SELECT
         (SELECT COALESCE(sum(e.amount), 0) FROM credit_entries e
            JOIN credit_transactions t ON t.id = e.transaction_id AND t.kind = 'hold'
            JOIN credit_wallets w ON w.id = e.wallet_id AND w.system_name = 'escrow'
           WHERE NOT EXISTS (SELECT 1 FROM credit_transactions s WHERE s.idempotency_key = 'settlement:job:' || t.job_id))::text AS open,
         (SELECT COALESCE(sum(e.amount), 0) FROM credit_entries e
            JOIN credit_wallets w ON w.id = e.wallet_id AND w.system_name = 'escrow')::text AS bal`,
    );
    const { open, bal } = escrow.rows[0]!;
    if (open !== bal) problems.push(`escrow balance ${bal} ≠ open holds ${open}`);
    const total = await this.ctx.db.query<{ s: string }>(`SELECT COALESCE(sum(amount), 0)::text AS s FROM credit_entries`);
    if (total.rows[0]!.s !== '0') problems.push(`ledger does not sum to zero (${total.rows[0]!.s})`);
    return { ok: problems.length === 0, transactions: count, headHash: prev, problems };
  }

  private async walletLabels(ids: string[]) {
    const { rows } = await this.ctx.db.query<WalletRow>(
      `SELECT id, kind, user_id, worker_id, system_name, '0' AS balance FROM credit_wallets WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(
      rows.map((w) => [w.id, { id: w.id, kind: w.kind, ref: w.user_id ?? w.worker_id ?? w.system_name }]),
    );
  }

  private txView(t: LedgerTx) {
    return {
      seq: t.seq,
      id: t.id,
      kind: t.kind,
      idempotencyKey: t.idempotencyKey,
      jobId: t.jobId,
      assignmentId: t.assignmentId,
      workerId: t.workerId,
      actor: { type: t.actorType, id: t.actorId },
      memo: t.memo,
      detail: t.detail,
      createdAt: t.createdAt,
      prevHash: t.prevHash,
      hash: t.hash,
      entries: t.entries.map((e) => ({ walletId: e.walletId, amount: credits(e.amount) })),
    };
  }

  private async assertWorkerVisible(actor: CreditActor, workerId: string) {
    const { rows } = await this.ctx.db.query<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM workers WHERE id = $1`, [
      workerId,
    ]);
    if (!rows[0] || (actor.role !== 'admin' && rows[0].owner_user_id !== actor.userId)) throw notFound('Worker');
  }
}

