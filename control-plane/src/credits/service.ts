// Business rules on top of the ledger: grants, job budgets and settlement (customers
// pay providers their price), withdrawals to the worker's owner, and read models (all derived).
import type pg from 'pg';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { audit } from '../audit.js';
import { conflict, forbidden, notFound } from '../errors.js';
import type { Resources } from '../scheduler/types.js';
import { GENESIS_HASH, Ledger, insufficientCredits, txHash, withEntries, type LedgerTx } from './ledger.js';
import { attemptCharge, holdAmount, MILLI, ratePerMinute, toCredits } from './pricing.js';
import { maxAttemptCost } from '../market/offer.js';

export interface CreditActor {
  userId: string;
  role: 'admin' | 'operator' | 'viewer' | 'member';
}

const credits = (milli: number) => ({ milli, credits: toCredits(milli) });

/** Idempotent replays return the original transaction; a reused key with other content is refused. */
function replay(existing: LedgerTx, same: (t: LedgerTx) => boolean) {
  if (!same(existing)) throw conflict('Idempotency key already used for a different operation');
  return existing;
}

// ---- in-transaction hooks (called by jobs / users code, inside their own transaction) ----

/** Welcome grant for a new user, in credits. */
export async function grantSignup(c: pg.PoolClient, userId: string, grantCredits: number) {
  const amount = Math.round(grantCredits * MILLI);
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
  /** Millicredits: the customer's budget for the job. */
  amount: number;
  detail: Record<string, unknown>;
}

/** Default budget when the customer sets none: the standard price × timeout. */
export const defaultBudget = (resources: Resources, timeoutSeconds: number) => holdAmount(resources, timeoutSeconds);

/**
 * Moves each job's budget from the customer's wallet into escrow. All or nothing: not
 * enough credits for every job → nothing is created.
 */
export async function holdForJobs(c: pg.PoolClient, ownerId: string, jobs: HoldRequest[]) {
  if (jobs.length === 0) return;
  const ledger = new Ledger(c);
  await ledger.lock();
  const wallet = await ledger.userWallet(ownerId);
  const escrow = await ledger.systemWallet('escrow');
  const total = jobs.reduce((s, j) => s + j.amount, 0);
  const available = await ledger.balance(wallet);
  if (total > available) throw insufficientCredits(total, available);
  await ledger.post(
    jobs.map((j) => ({
      kind: 'hold' as const,
      idempotencyKey: `hold:job:${j.jobId}`,
      jobId: j.jobId,
      entries: [
        { walletId: wallet, amount: -j.amount },
        { walletId: escrow, amount: j.amount },
      ],
      actorType: 'user' as const,
      actorId: ownerId,
      memo: 'Orçamento reservado para o job',
      detail: j.detail,
    })),
  );
}

/** Slack over twice the fastest agreeing replica before billing stops counting. */
export const STALL_GRACE_SECONDS = 30;

const fmtCredits = (milli: number) => toCredits(milli).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/**
 * Closes a job's escrow when it reaches a terminal state, in one transaction:
 *   COMPLETED → each provider is paid its own price × the seconds its productive attempts
 *               ran (completed, or resumable timeouts whose checkpoint was kept), each
 *               attempt capped at price × timeout; the rest goes back to the customer.
 *   otherwise → full refund.
 * The total paid never exceeds the budget held. Runs once per job (idempotency key).
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
    await c.query<{
      owner_id: string;
      status: string;
      resources: Resources;
      retry_on_timeout: boolean;
      timeout_seconds: number;
      verification: string;
    }>(
      `SELECT owner_id, status, resources, retry_on_timeout, timeout_seconds, verification FROM jobs WHERE id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!job) return null;
  // Work that is paid for:
  //   COMPLETED  → the result (verified jobs: only replicas that agreed) and resumable
  //                timeouts whose checkpoint was used;
  //   CANCELLED  → what ran until the customer cancelled (it asked for that work);
  //   otherwise  → nothing: failed, timed out or disputed work is not paid.
  const paidStatuses =
    job.status === 'COMPLETED' ? ['completed', 'timeout'] : job.status === 'CANCELLED' ? ['completed', 'timeout', 'cancelled'] : [];
  const attempts = paidStatuses.length
    ? (
        await c.query<{
          id: string;
          status: string;
          seconds: number;
          worker_id: string;
          name: string;
          price_rate: number | null;
          reserved: Resources;
          verdict: string | null;
        }>(
          `SELECT a.id, a.status, a.worker_id, w.name, a.price_rate, a.reserved, a.verdict,
                  EXTRACT(EPOCH FROM (a.finished_at - a.started_at))::float8 AS seconds
             FROM job_assignments a JOIN workers w ON w.id = a.worker_id
            WHERE a.job_id = $1 AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL
              AND a.status = ANY($2::text[])
              AND (a.status <> 'timeout' OR $3)
              AND (a.status <> 'completed' OR $4 = 'none' OR a.verdict = 'agreed' OR ($5 = 'CANCELLED' AND a.verdict IS NULL))
            ORDER BY a.attempt`,
          [jobId, paidStatuses, job.retry_on_timeout, job.verification, job.status],
        )
      ).rows
    : [];
  // Verified jobs have a yardstick: no replica is paid for more than twice the fastest
  // agreeing replica (+30 s), so stalling before answering does not pay.
  const agreed = attempts.filter((a) => a.verdict === 'agreed').map((a) => a.seconds);
  const capSeconds = agreed.length ? 2 * Math.min(...agreed) + STALL_GRACE_SECONDS : Infinity;
  let left = held;
  const paid = attempts.map((a) => {
    // Attempts assigned before provider prices existed are paid at the standard rate.
    const rate = a.price_rate ?? ratePerMinute(a.reserved ?? job.resources);
    const billedSeconds = Math.min(a.seconds, capSeconds);
    const due = Math.min(attemptCharge(rate, billedSeconds), maxAttemptCost(rate, job.timeout_seconds));
    const charge = Math.min(due, left);
    left -= charge;
    const seconds = Math.round(a.seconds * 1000) / 1000;
    return {
      assignmentId: a.id,
      workerId: a.worker_id,
      status: a.status,
      seconds,
      ...(billedSeconds < a.seconds ? { billedSeconds: Math.round(billedSeconds * 1000) / 1000 } : {}),
      ratePerMinute: rate,
      charge,
      summary:
        `Worker ${a.name} recebeu ${fmtCredits(charge)} créditos: ` +
        `${(billedSeconds / 60).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} min × ` +
        `${fmtCredits(rate)} créditos/min (preço do provedor para os recursos reservados)` +
        (billedSeconds < a.seconds ? `, tempo limitado a 2× a réplica mais rápida` : '') +
        (charge < due ? `, limitado pelo orçamento` : '') +
        '.',
    };
  });
  const cost = held - left;
  const refund = left;
  const perWorker = new Map<string, number>();
  for (const p of paid) if (p.charge > 0) perWorker.set(p.workerId, (perWorker.get(p.workerId) ?? 0) + p.charge);
  const entries = [{ walletId: escrow, amount: -held }];
  for (const [workerId, amount] of perWorker) entries.push({ walletId: await ledger.workerWallet(workerId), amount });
  if (refund > 0) entries.push({ walletId: await ledger.userWallet(job.owner_id), amount: refund });
  const memo =
    job.status === 'COMPLETED'
      ? `Job concluído: ${fmtCredits(cost)} créditos pagos ao(s) provedor(es), ${fmtCredits(refund)} devolvidos`
      : job.status === 'CANCELLED' && cost > 0
        ? `Job cancelado: ${fmtCredits(cost)} créditos pelo trabalho já feito, ${fmtCredits(refund)} devolvidos`
        : `Job ${job.status}: orçamento de ${fmtCredits(held)} créditos devolvido`;
  const [tx] = await ledger.post([
    {
      kind: 'settlement',
      idempotencyKey: key,
      jobId,
      workerId: perWorker.size === 1 ? [...perWorker.keys()][0]! : null,
      entries,
      actorType: 'system',
      memo,
      detail: {
        jobStatus: job.status,
        held,
        charged: cost,
        refunded: refund,
        attempts: paid,
        formula: 'per productive attempt: min(ceil(ratePerMinute × ceil(seconds) / 60), ceil(ratePerMinute × timeout / 60)); Σ ≤ held',
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

  /**
   * What the caller's computers were paid (admins: any computer): one row per job and
   * worker, with the attempts, seconds and price behind the amount.
   */
  async earnings(actor: CreditActor, f: { workerId?: string | undefined; limit: number; beforeSeq?: number | undefined }) {
    if (f.workerId) await this.assertWorkerVisible(actor, f.workerId);
    const scope = actor.role === 'admin' ? null : actor.userId;
    const base = `FROM credit_entries e
         JOIN credit_wallets cw ON cw.id = e.wallet_id AND cw.kind = 'worker'
         JOIN credit_transactions t ON t.id = e.transaction_id AND t.kind IN ('settlement', 'earning')
         JOIN workers w ON w.id = cw.worker_id
        WHERE e.amount > 0 AND ($1::uuid IS NULL OR w.owner_user_id = $1) AND ($2::uuid IS NULL OR w.id = $2)`;
    const { rows } = await this.ctx.db.query(
      `SELECT t.seq, t.id, t.kind, t.job_id, t.detail, t.memo, t.created_at, w.id AS worker_id, w.name AS worker_name,
              e.amount::text AS amount
         ${base} AND ($3::bigint IS NULL OR t.seq < $3)
        ORDER BY t.seq DESC, w.id LIMIT $4`,
      [scope, f.workerId ?? null, f.beforeSeq ?? null, f.limit + 1],
    );
    const totals = await this.ctx.db.query<{ worker_id: string; name: string; n: number; total: string }>(
      `SELECT w.id AS worker_id, w.name, count(*)::int AS n, sum(e.amount)::text AS total ${base}
        GROUP BY w.id, w.name ORDER BY w.name`,
      [scope, f.workerId ?? null],
    );
    const page = rows.slice(0, f.limit);
    return {
      byWorker: totals.rows.map((r) => ({ workerId: r.worker_id, name: r.name, payments: r.n, total: credits(Number(r.total)) })),
      items: page.map((r) => {
        const attempts = ((r.detail?.attempts ?? []) as { workerId?: string; summary?: string }[]).filter((a) => a.workerId === r.worker_id);
        return {
          seq: Number(r.seq),
          id: r.id,
          kind: r.kind,
          workerId: r.worker_id,
          workerName: r.worker_name,
          jobId: r.job_id,
          amount: credits(Number(r.amount)),
          summary: r.kind === 'settlement' ? attempts.map((a) => a.summary).join(' ') : r.memo,
          attempts: r.kind === 'settlement' ? attempts : [],
          createdAt: r.created_at.toISOString(),
        };
      }),
      nextCursor: rows.length > f.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  /** What the caller's jobs cost: one row per job with hold, charge and refund. */
  async spending(userId: string, f: { limit: number; beforeSeq?: number | undefined }) {
    const { rows } = await this.ctx.db.query(
      `SELECT h.seq, h.job_id, j.name, j.type, j.status, h.created_at AS held_at,
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
      totals: { paid: credits(Number(totals.rows[0]!.charged)), held: credits(Number(totals.rows[0]!.held)) },
      items: page.map((r) => ({
        seq: Number(r.seq),
        jobId: r.job_id,
        jobName: r.name,
        type: r.type,
        jobStatus: r.status,
        budget: credits(Number(r.held)),
        state: r.settlement_id ? 'settled' : 'held',
        paid: r.settlement ? credits(Number(r.settlement.charged)) : null,
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

