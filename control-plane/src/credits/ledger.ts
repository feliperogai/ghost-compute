// Append-only, double-entry credit ledger. The only code that writes credit_* tables.
//
// Rules (also enforced by the database, see migrations/008_credits.sql):
//   - rows are never updated or deleted; a balance is SUM(entries) of a wallet;
//   - each transaction's entries sum to zero; only 'issuance' may go negative;
//   - one writer at a time (transaction-scoped advisory lock), so the balance a
//     writer checks is the balance it commits against: no double spending;
//   - every business event has an idempotency key (UNIQUE): replays cannot double-post;
//   - each transaction carries the hash of the previous one (tamper evidence).
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../auth/crypto.js';
import { AppError, conflict } from '../errors.js';

export const LEDGER_LOCK = 7_291_001;
export const GENESIS_HASH = '0'.repeat(64);

export type TxKind = 'grant' | 'earning' | 'hold' | 'settlement' | 'withdrawal';
export type SystemWallet = 'issuance' | 'escrow' | 'consumption';

export interface Entry {
  walletId: string;
  /** Millicredits; positive = credit to the wallet, negative = debit. Never 0. */
  amount: number;
}

export interface Posting {
  kind: TxKind;
  idempotencyKey: string;
  entries: Entry[];
  jobId?: string | null;
  assignmentId?: string | null;
  workerId?: string | null;
  actorType: 'user' | 'worker' | 'system';
  actorId?: string | null;
  memo: string;
  detail?: Record<string, unknown>;
}

export interface LedgerTx {
  seq: number;
  id: string;
  kind: TxKind;
  idempotencyKey: string;
  jobId: string | null;
  assignmentId: string | null;
  workerId: string | null;
  actorType: string;
  actorId: string | null;
  memo: string;
  detail: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
  hash: string;
  entries: Entry[];
}

export const insufficientCredits = (needed: number, available: number) =>
  new AppError(409, 'INSUFFICIENT_CREDITS', 'Not enough credits', { needed, available });

/** JSON with object keys sorted at every level (jsonb does not keep key order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Hash of a transaction, chained to the previous one. */
export function txHash(prevHash: string, t: Omit<LedgerTx, 'seq' | 'hash' | 'prevHash'>): string {
  const body = canonicalJson({
    id: t.id,
    kind: t.kind,
    key: t.idempotencyKey,
    jobId: t.jobId,
    assignmentId: t.assignmentId,
    workerId: t.workerId,
    actorType: t.actorType,
    actorId: t.actorId,
    memo: t.memo,
    detail: t.detail,
    createdAt: t.createdAt,
    entries: [...t.entries].sort((a, b) => (a.walletId < b.walletId ? -1 : 1)).map((e) => [e.walletId, String(e.amount)]),
  });
  return sha256Hex(`${prevHash}\n${body}`);
}

export class Ledger {
  private locked = false;

  constructor(private readonly c: pg.PoolClient) {}

  /** Serializes ledger writers until COMMIT/ROLLBACK. Take it before reading balances you will act on. */
  async lock() {
    if (this.locked) return;
    await this.c.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_LOCK]);
    this.locked = true;
  }

  async userWallet(userId: string) {
    return this.wallet(`INSERT INTO credit_wallets (kind, user_id) VALUES ('user', $1) ON CONFLICT (user_id) DO NOTHING RETURNING id`,
      `SELECT id FROM credit_wallets WHERE user_id = $1`, userId);
  }

  async workerWallet(workerId: string) {
    return this.wallet(`INSERT INTO credit_wallets (kind, worker_id) VALUES ('worker', $1) ON CONFLICT (worker_id) DO NOTHING RETURNING id`,
      `SELECT id FROM credit_wallets WHERE worker_id = $1`, workerId);
  }

  async systemWallet(name: SystemWallet) {
    return this.wallet(
      `INSERT INTO credit_wallets (kind, system_name, allow_negative) VALUES ('system', $1, $1 = 'issuance')
       ON CONFLICT (system_name) DO NOTHING RETURNING id`,
      `SELECT id FROM credit_wallets WHERE system_name = $1`,
      name,
    );
  }

  private async wallet(insert: string, select: string, arg: string): Promise<string> {
    const found = await this.c.query<{ id: string }>(select, [arg]);
    if (found.rows[0]) return found.rows[0].id;
    const ins = await this.c.query<{ id: string }>(insert, [arg]);
    if (ins.rows[0]) return ins.rows[0].id;
    return (await this.c.query<{ id: string }>(select, [arg])).rows[0]!.id;
  }

  /** Derived, never stored. */
  async balance(walletId: string): Promise<number> {
    const { rows } = await this.c.query<{ b: string }>(
      `SELECT COALESCE(sum(amount), 0)::text AS b FROM credit_entries WHERE wallet_id = $1`,
      [walletId],
    );
    return Number(rows[0]!.b);
  }

  async findByKey(key: string): Promise<LedgerTx | null> {
    const { rows } = await this.c.query(`SELECT * FROM credit_transactions WHERE idempotency_key = $1`, [key]);
    if (!rows[0]) return null;
    return (await withEntries(this.c, rows))[0]!;
  }

  /**
   * Appends transactions atomically (all or nothing, in order). Rejects unbalanced
   * or empty postings, zero/fractional amounts, reused keys and any balance that
   * would go negative — checked against the committed ledger under the lock.
   */
  async post(postings: Posting[]): Promise<LedgerTx[]> {
    if (postings.length === 0) return [];
    await this.lock();
    const keys = new Set<string>();
    const delta = new Map<string, number>();
    for (const p of postings) {
      if (p.entries.length < 2) throw new Error(`credit transaction ${p.idempotencyKey} needs at least two entries`);
      if (keys.has(p.idempotencyKey)) throw conflict(`Duplicate idempotency key ${p.idempotencyKey}`);
      keys.add(p.idempotencyKey);
      const wallets = new Set<string>();
      let sum = 0;
      for (const e of p.entries) {
        if (!Number.isSafeInteger(e.amount) || e.amount === 0)
          throw new AppError(400, 'INVALID_AMOUNT', 'Credit amounts must be non-zero whole millicredits');
        if (wallets.has(e.walletId)) throw new Error(`wallet repeated in ${p.idempotencyKey}`);
        wallets.add(e.walletId);
        sum += e.amount;
        delta.set(e.walletId, (delta.get(e.walletId) ?? 0) + e.amount);
      }
      if (sum !== 0) throw new Error(`credit transaction ${p.idempotencyKey} is unbalanced (${sum})`);
    }
    const dup = await this.c.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM credit_transactions WHERE idempotency_key = ANY($1::text[])`,
      [[...keys]],
    );
    if (dup.rows[0]) throw conflict(`Idempotency key already used: ${dup.rows[0].idempotency_key}`);

    // Overdraft check on the net effect of the whole batch.
    const ids = [...delta.keys()];
    const { rows: bals } = await this.c.query<{ id: string; allow_negative: boolean; b: string }>(
      `SELECT w.id, w.allow_negative, COALESCE((SELECT sum(e.amount) FROM credit_entries e WHERE e.wallet_id = w.id), 0)::text AS b
         FROM credit_wallets w WHERE w.id = ANY($1::uuid[])`,
      [ids],
    );
    if (bals.length !== ids.length) throw new Error('unknown credit wallet');
    for (const w of bals) {
      const after = Number(w.b) + delta.get(w.id)!;
      if (!w.allow_negative && after < 0) throw insufficientCredits(-delta.get(w.id)!, Number(w.b));
    }

    const prev = await this.c.query<{ hash: string }>(`SELECT hash FROM credit_transactions ORDER BY seq DESC LIMIT 1`);
    let prevHash = prev.rows[0]?.hash ?? GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const txs: Omit<LedgerTx, 'seq'>[] = postings.map((p) => {
      const base = {
        id: randomUUID(),
        kind: p.kind,
        idempotencyKey: p.idempotencyKey,
        jobId: p.jobId ?? null,
        assignmentId: p.assignmentId ?? null,
        workerId: p.workerId ?? null,
        actorType: p.actorType,
        actorId: p.actorId ?? null,
        memo: p.memo,
        detail: JSON.parse(JSON.stringify(p.detail ?? {})) as Record<string, unknown>,
        createdAt,
        entries: p.entries.map((e) => ({ ...e })),
      };
      const hash = txHash(prevHash, base);
      const t = { ...base, prevHash, hash };
      prevHash = hash;
      return t;
    });

    const inserted = await this.c.query<{ seq: string; id: string }>(
      `INSERT INTO credit_transactions (id, kind, idempotency_key, job_id, assignment_id, worker_id, actor_type, actor_id,
                                        memo, detail, created_at, prev_hash, hash)
       SELECT id, kind, key, job, asg, wrk, at, aid, memo, detail::jsonb, $11::timestamptz, prev, hash
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::uuid[],
                     $9::text[], $10::text[], $12::text[], $13::text[])
              WITH ORDINALITY AS t(id, kind, key, job, asg, wrk, at, aid, memo, detail, prev, hash, ord)
        ORDER BY ord
       RETURNING seq, id`,
      [
        txs.map((t) => t.id),
        txs.map((t) => t.kind),
        txs.map((t) => t.idempotencyKey),
        txs.map((t) => t.jobId),
        txs.map((t) => t.assignmentId),
        txs.map((t) => t.workerId),
        txs.map((t) => t.actorType),
        txs.map((t) => t.actorId),
        txs.map((t) => t.memo),
        txs.map((t) => JSON.stringify(t.detail)),
        createdAt,
        txs.map((t) => t.prevHash),
        txs.map((t) => t.hash),
      ],
    );
    const flat = txs.flatMap((t) => t.entries.map((e) => ({ tx: t.id, ...e })));
    await this.c.query(
      `INSERT INTO credit_entries (transaction_id, wallet_id, amount)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::bigint[])`,
      [flat.map((e) => e.tx), flat.map((e) => e.walletId), flat.map((e) => String(e.amount))],
    );
    const seqOf = new Map(inserted.rows.map((r) => [r.id, Number(r.seq)]));
    return txs.map((t) => ({ ...t, seq: seqOf.get(t.id)! }));
  }
}

/** Rows of credit_transactions → LedgerTx with their entries. */
export async function withEntries(db: pg.PoolClient | pg.Pool, rows: Record<string, any>[]): Promise<LedgerTx[]> {
  if (rows.length === 0) return [];
  const { rows: es } = await db.query<{ transaction_id: string; wallet_id: string; amount: string }>(
    `SELECT transaction_id, wallet_id, amount::text FROM credit_entries WHERE transaction_id = ANY($1::uuid[]) ORDER BY id`,
    [rows.map((r) => r.id)],
  );
  const by = new Map<string, Entry[]>();
  for (const e of es) {
    const list = by.get(e.transaction_id) ?? [];
    list.push({ walletId: e.wallet_id, amount: Number(e.amount) });
    by.set(e.transaction_id, list);
  }
  return rows.map((r) => ({
    seq: Number(r.seq),
    id: r.id,
    kind: r.kind,
    idempotencyKey: r.idempotency_key,
    jobId: r.job_id,
    assignmentId: r.assignment_id,
    workerId: r.worker_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    memo: r.memo,
    detail: r.detail,
    createdAt: (r.created_at as Date).toISOString(),
    prevHash: r.prev_hash,
    hash: r.hash,
    entries: by.get(r.id) ?? [],
  }));
}
