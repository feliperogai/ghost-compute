import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createJob, heartbeat, makeUser, registerWorker, reset, setup, type Harness, type TestWorker } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import { withTx } from '../src/db/pool.js';
import { Ledger } from '../src/credits/ledger.js';
import { settleJob } from '../src/credits/service.js';
import {
  attemptCharge,
  availabilityMultiplier,
  computeEarning,
  holdAmount,
  performanceMultiplier,
  ratePerMinute,
  toMilli,
} from '../src/credits/pricing.js';
import type { SchedulerEngine } from '../src/scheduler/index.js';

const RES = { cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 };

describe('pricing (pure, deterministic)', () => {
  it('rates resources in whole millicredits per minute', () => {
    expect(ratePerMinute(RES)).toBe(1125); // 1 core + 0.5 GB
    expect(ratePerMinute({ cpuCores: 2, ramMb: 2048, gpu: true, vramMb: 4096, diskMb: 0 })).toBe(2000 + 500 + 4000 + 1000);
    expect(holdAmount(RES, 60)).toBe(1125);
    expect(holdAmount(RES, 3600)).toBe(67_500);
    // Per second, rounded up; never more than rate × timeout for an attempt within its timeout.
    expect(attemptCharge(1125, 30)).toBe(563);
    expect(attemptCharge(1125, 0.2)).toBe(19); // minimum one second
    expect(attemptCharge(1125, 60)).toBe(holdAmount(RES, 60));
  });

  it('multipliers: performance from the verified profile, availability from time online', () => {
    expect(performanceMultiplier({ verified: false, score: 5000 })).toBe(0.75);
    expect(performanceMultiplier({ verified: true, score: null })).toBe(0.75);
    expect(performanceMultiplier({ verified: true, score: 1000 })).toBe(1);
    expect(performanceMultiplier({ verified: true, score: 1234 })).toBe(1.234);
    expect(performanceMultiplier({ verified: true, score: 100 })).toBe(0.5);
    expect(performanceMultiplier({ verified: true, score: 9000 })).toBe(2);
    expect(availabilityMultiplier(0)).toBe(0.8);
    expect(availabilityMultiplier(720)).toBe(1);
    expect(availabilityMultiplier(1440)).toBe(1.2);
    expect(availabilityMultiplier(99_999)).toBe(1.2);
  });

  it('earning = minutes × rate × performance × availability, same inputs → same amount', () => {
    const input = { workerName: 'pc', seconds: 600, resources: RES, performance: { verified: true, score: 1500 }, onlineMinutes: 1440 };
    const e = computeEarning(input);
    expect(e.amount).toBe(Math.floor(10 * 1125 * 1.5 * 1.2)); // 20250
    expect(computeEarning(input)).toEqual(e);
    expect(e.detail.summary).toMatch(/^Worker pc ganhou 20,25 créditos: 10 min × 1,125 créditos\/min .* desempenho 1,5 \(score 1500\) × disponibilidade 1,2/);
    expect(computeEarning({ ...input, seconds: 0 }).amount).toBe(0);
  });

  it('parses credit amounts exactly; rejects what is not a whole millicredit', () => {
    expect(toMilli(1)).toBe(1000);
    expect(toMilli(0.001)).toBe(1);
    expect(toMilli(12.345)).toBe(12_345);
    expect(toMilli(0.0001)).toBeNull();
    expect(toMilli(1.23456)).toBeNull();
    expect(toMilli(Number.NaN)).toBeNull();
  });
});

let h: Harness;
let engine: SchedulerEngine;
let op: string;
beforeAll(async () => {
  // Small welcome grant so limits are easy to hit.
  h = await setup({ CREDITS_INITIAL_GRANT: '100' });
  engine = createEngine(h.rt);
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
});
afterAll(() => h.close());

const get = (url: string, token = op) => h.app.inject({ url, headers: auth(token) });
const wallet = async (token = op) => (await get('/v1/credits/wallet', token)).json();
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const post = (w: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(w.token), ...(payload ? { payload } : {}) });
const verify = async () => (await get('/v1/credits/ledger/verify', h.adminToken)).json();
const userId = async (token: string) => (await wallet(token)).owner.id as string;
const grant = (payload: object) =>
  h.app.inject({ method: 'POST', url: '/v1/credits/grants', headers: auth(h.adminToken), payload });

/** 1 core / 512 MB for 60 s: hold of exactly 1.125 credits. */
const smallJob = { timeout: 60 };

async function runJob(token: string, over: object = {}) {
  const w = await registerWorker(h, { name: `pc-${randomUUID().slice(0, 4)}` });
  await heartbeat(h, w);
  const j = await createJob(h, token, over);
  await engine.tick();
  const [a] = (await heartbeat(h, w)).json().assignments;
  await post(w, `/v1/worker/assignments/${a.assignmentId}/accept`);
  return { w, j, a: a.assignmentId as string };
}

/** Pretends the attempt started `seconds` ago (assignments are mutable; the ledger is not). */
const ranFor = (assignmentId: string, seconds: number) =>
  h.rt.db.query(`UPDATE job_assignments SET started_at = now() - make_interval(secs => $2) WHERE id = $1`, [assignmentId, seconds]);

describe('wallets and the job cycle', () => {
  it('every new user starts with the welcome grant; balance is derived from the ledger', async () => {
    const w = await wallet();
    expect(w.balance).toEqual({ milli: 100_000, credits: 100 });
    expect(w.held.credits).toBe(0);
    expect(w.totals.grant.in.credits).toBe(100);
    const tx = (await get('/v1/credits/transactions')).json();
    expect(tx.items).toHaveLength(1);
    expect(tx.items[0]).toMatchObject({ kind: 'grant', amount: { credits: 100 }, balanceAfter: { credits: 100 } });
    // No balance column anywhere.
    const cols = await h.rt.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'credit_%' AND column_name LIKE '%balance%'`,
    );
    expect(cols.rows).toEqual([]);
  });

  it('creating a job holds its maximum cost; completing it charges the time used and pays the worker', async () => {
    const { w, j, a } = await runJob(op, { timeout: 3600 });
    expect((await wallet()).balance.credits).toBe(100 - 67.5);
    expect((await wallet()).held.credits).toBe(67.5);

    await ranFor(a, 600);
    await post(w, `/v1/worker/assignments/${a}/result`, { status: 'completed', output: { ok: 1 }, outputSha256: sha({ ok: 1 }) });

    // Owner: charged 10 minutes × 1.125 = 11.25 (±1 s of test time), rest refunded.
    const spend = (await get('/v1/credits/spending')).json();
    expect(spend.items).toHaveLength(1);
    const s = spend.items[0];
    expect(s).toMatchObject({ jobId: j.id, state: 'settled', jobStatus: 'COMPLETED', held: { credits: 67.5 } });
    expect(s.charged.credits).toBeGreaterThanOrEqual(11.25);
    expect(s.charged.credits).toBeLessThan(11.3);
    expect(s.charged.milli + s.refunded.milli).toBe(67_500);
    const after = await wallet();
    expect(after.held.credits).toBe(0);
    expect(after.balance.milli).toBe(100_000 - s.charged.milli);

    // Worker: paid for compute time × resources × performance × availability, with the calculation.
    const earn = (await get(`/v1/credits/earnings?workerId=${w.id}`, h.adminToken)).json();
    expect(earn.items).toHaveLength(1);
    const e = earn.items[0];
    expect(e.calculation.performance).toEqual({ verified: false, score: null, multiplier: 0.75 });
    expect(e.calculation.availability.multiplier).toBeCloseTo(0.8, 2); // freshly online
    expect(e.summary).toMatch(/^Worker pc-.{4} ganhou .* créditos: 10 min × 1,125 créditos\/min/);
    // Reproducible from the stored inputs alone.
    const again = computeEarning({
      workerName: e.workerName,
      seconds: e.calculation.seconds,
      resources: e.calculation.resources,
      performance: { verified: e.calculation.performance.verified, score: e.calculation.performance.score },
      onlineMinutes: e.calculation.availability.onlineMinutes,
    });
    expect(again.amount).toBe(e.amount.milli);

    // The desktop app's numbers come from the same ledger.
    const stats = (await h.app.inject({ url: '/v1/worker/me/stats', headers: auth(w.token) })).json();
    expect(stats.credits).toBe(e.amount.credits);
    expect(stats.wallet).toEqual({ balance: e.amount.credits, earned: e.amount.credits });
    expect(await verify()).toMatchObject({ ok: true, problems: [] });
  });

  it('failed and cancelled jobs are refunded in full, exactly once', async () => {
    const { w, a } = await runJob(op, smallJob);
    await post(w, `/v1/worker/assignments/${a}/result`, { status: 'failed', error: 'bad input', retryable: false });
    const c = await createJob(h, op, smallJob);
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${c.id}/cancel`, headers: auth(op) });
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${c.id}/cancel`, headers: auth(op) }); // 409, no second refund

    const w2 = await wallet();
    expect(w2.balance.credits).toBe(100);
    expect(w2.held.credits).toBe(0);
    const s = (await get('/v1/credits/spending')).json();
    expect(s.items.map((i: { jobStatus: string; charged: { credits: number } }) => [i.jobStatus, i.charged.credits]).sort()).toEqual([
      ['CANCELLED', 0],
      ['FAILED', 0],
    ]);
    expect((await get('/v1/credits/earnings', h.adminToken)).json().items).toEqual([]);
    expect((await h.rt.db.query(`SELECT count(*)::int AS n FROM credit_transactions WHERE kind = 'settlement'`)).rows[0].n).toBe(2);
    expect((await verify()).ok).toBe(true);
  });

  it('refuses a job the owner cannot afford, and creates nothing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: auth(op),
      payload: { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, resources: { cpuCores: 8 }, timeout: 3600 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { needed: 487_500, available: 100_000 } });
    expect((await h.rt.db.query(`SELECT count(*)::int AS n FROM jobs`)).rows[0].n).toBe(0);
    expect(await h.rt.queue.size()).toBe(0);
    expect((await wallet()).balance.credits).toBe(100);
  });
});

describe('double spending and concurrency', () => {
  it('concurrent job submissions never spend more than the balance', async () => {
    // 100 credits / 7.5 per job (1 core, 512 MB, 400 s) → 13 fit, the 14th does not.
    const per = holdAmount(RES, 400);
    expect(per).toBe(7500);
    const fit = Math.floor(100_000 / per);
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/v1/jobs',
          headers: auth(op),
          payload: { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, timeout: 400 },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(fit);
    expect(codes.filter((c) => c === 409)).toHaveLength(40 - fit);
    const w = await wallet();
    expect(w.balance.milli).toBe(100_000 - fit * per);
    expect(w.balance.milli).toBeGreaterThanOrEqual(0);
    expect(w.held.milli).toBe(fit * per);
    expect((await h.rt.db.query(`SELECT count(*)::int AS n FROM jobs`)).rows[0].n).toBe(fit);
    expect((await verify()).ok).toBe(true);
  });

  it('concurrent withdrawals cannot take the same earnings twice', async () => {
    const admin = await userId(h.adminToken);
    const w = await registerWorker(h, { name: 'earner' }); // owned by the admin (enrolled it)
    // 10 credits earned by the worker.
    await withTx(h.rt.db, async (c) => {
      const l = new Ledger(c);
      await l.post([
        {
          kind: 'earning',
          idempotencyKey: `test-earning-${w.id}`,
          workerId: w.id,
          entries: [
            { walletId: await l.systemWallet('issuance'), amount: -10_000 },
            { walletId: await l.workerWallet(w.id), amount: 10_000 },
          ],
          actorType: 'system',
          memo: 'test',
        },
      ]);
    });
    const tries = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        h.app.inject({
          method: 'POST',
          url: `/v1/credits/workers/${w.id}/withdraw`,
          headers: auth(h.adminToken),
          payload: { amount: 3, idempotencyKey: `withdraw-${i}-xxxxxxxx` },
        }),
      ),
    );
    expect(tries.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(tries.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'INSUFFICIENT_CREDITS')).toBe(true);
    expect((await get(`/v1/credits/workers/${w.id}/wallet`, h.adminToken)).json().balance.milli).toBe(1000);
    const aw = await wallet(h.adminToken);
    expect(aw.owner.id).toBe(admin);
    expect(aw.totals.withdrawal.in.credits).toBe(9);
    expect((await verify()).ok).toBe(true);
  });

  it('the same idempotency key, sent concurrently, posts once; other requests replay it', async () => {
    const uid = await userId(op);
    const body = { userId: uid, amount: 50, reason: 'bonus', idempotencyKey: 'grant-bonus-2026-09' };
    const res = await Promise.all(Array.from({ length: 20 }, () => grant(body)));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(19);
    expect(new Set(res.map((r) => r.json().transaction.id)).size).toBe(1);
    expect((await wallet()).balance.credits).toBe(150);
    // Reusing the key for something else is refused.
    const other = await grant({ ...body, amount: 51 });
    expect(other.statusCode).toBe(409);
    expect((await wallet()).balance.credits).toBe(150);
  });

  it('settles a job once even when completion, cancellation and settlement race', async () => {
    const { w, j, a } = await runJob(op, smallJob);
    const outcomes = await Promise.allSettled([
      post(w, `/v1/worker/assignments/${a}/result`, { status: 'completed', output: { ok: 1 }, outputSha256: sha({ ok: 1 }) }),
      h.app.inject({ method: 'POST', url: `/v1/jobs/${j.id}/cancel`, headers: auth(op) }),
      ...Array.from({ length: 5 }, () => withTx(h.rt.db, (c) => settleJob(c, j.id))),
    ]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    const n = await h.rt.db.query(
      `SELECT kind, count(*)::int AS n FROM credit_transactions WHERE job_id = $1 GROUP BY kind ORDER BY kind`,
      [j.id],
    );
    const counts = Object.fromEntries(n.rows.map((r) => [r.kind, r.n]));
    expect(counts.hold).toBe(1);
    expect(counts.settlement).toBe(1);
    expect(counts.earning ?? 0).toBeLessThanOrEqual(1);
    expect((await wallet()).held.credits).toBe(0);
    expect((await verify()).ok).toBe(true);
  });

  it('mixed concurrent load keeps every invariant', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => makeUser(h, 'operator', `u${i}@ghost.test`)));
    const ops: Promise<unknown>[] = [];
    for (const [i, t] of users.entries()) {
      const uid = await userId(t);
      for (let k = 0; k < 10; k++) {
        ops.push(createJob(h, t, { timeout: 600 }).catch(() => null)); // 11.25 each
        ops.push(grant({ userId: uid, amount: 5, reason: 'load', idempotencyKey: `load-${i}-${k % 3}-xxxx` }));
      }
    }
    await Promise.all(ops);
    const jobs = (await h.rt.db.query(`SELECT id FROM jobs`)).rows;
    await Promise.all(jobs.map((r) => h.app.inject({ method: 'POST', url: `/v1/jobs/${r.id}/cancel`, headers: auth(h.adminToken) })));
    for (const t of users) {
      const w = await wallet(t);
      expect(w.held.milli).toBe(0);
      expect(w.balance.credits).toBe(100 + 3 * 5); // everything refunded; 3 distinct grant keys
    }
    const v = await verify();
    expect(v).toMatchObject({ ok: true, problems: [] });
    const sum = await h.rt.db.query(`SELECT sum(amount)::text AS s FROM credit_entries`);
    expect(sum.rows[0].s).toBe('0');
  });
});

describe('negative values and invalid amounts', () => {
  it.each([[-1], [0], [-0.001], [0.0001], [1.23456], ['10'], [null], [1e12], [Number.MAX_SAFE_INTEGER]])(
    'rejects grant amount %j',
    async (amount) => {
      const res = await grant({ userId: await userId(op), amount, reason: 'x', idempotencyKey: `bad-${String(amount)}-xxxxx` });
      expect(res.statusCode).toBe(400);
      expect((await wallet()).balance.credits).toBe(100);
    },
  );

  it.each([[-5], [0], [0.0005]])('rejects withdrawal amount %j', async (amount) => {
    const w = await registerWorker(h, { name: 'x' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/credits/workers/${w.id}/withdraw`,
      headers: auth(h.adminToken),
      payload: { amount, idempotencyKey: 'neg-withdraw-xxxx' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a worker wallet cannot go below zero; only the owner withdraws; viewers cannot grant', async () => {
    const w = await registerWorker(h, { name: 'empty' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/credits/workers/${w.id}/withdraw`,
      headers: auth(h.adminToken),
      payload: { amount: 0.001, idempotencyKey: 'empty-wallet-xxxx' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_CREDITS');
    const notOwner = await h.app.inject({
      method: 'POST',
      url: `/v1/credits/workers/${w.id}/withdraw`,
      headers: auth(op),
      payload: { amount: 1, idempotencyKey: 'not-owner-xxxxx' },
    });
    expect(notOwner.statusCode).toBe(404);
    expect((await get(`/v1/credits/workers/${w.id}/wallet`)).statusCode).toBe(404);
    const viewer = await makeUser(h, 'viewer');
    const g = await h.app.inject({
      method: 'POST',
      url: '/v1/credits/grants',
      headers: auth(viewer),
      payload: { userId: await userId(op), amount: 1, reason: 'x', idempotencyKey: 'viewer-grant-xxxx' },
    });
    expect(g.statusCode).toBe(403);
    expect((await get('/v1/credits/ledger', viewer)).statusCode).toBe(403);
  });

  it('the ledger API refuses zero, fractional, unbalanced and overdrawn postings', async () => {
    const uid = await userId(op);
    const attempt = (amounts: number[], key: string = randomUUID()) =>
      withTx(h.rt.db, async (c) => {
        const l = new Ledger(c);
        const wallets = [await l.systemWallet('issuance'), await l.userWallet(uid), await l.systemWallet('consumption')];
        return l.post([
          { kind: 'grant', idempotencyKey: key, entries: amounts.map((amount, i) => ({ walletId: wallets[i]!, amount })), actorType: 'system', memo: 't' },
        ]);
      });
    await expect(attempt([0, 0])).rejects.toThrow(/non-zero whole/);
    await expect(attempt([-1.5, 1.5])).rejects.toThrow(/non-zero whole/);
    await expect(attempt([-10, 5])).rejects.toThrow(/unbalanced/);
    await expect(attempt([-10])).rejects.toThrow(/two entries/);
    // User → consumption beyond the balance.
    await expect(attempt([1, -100_001, 100_000])).rejects.toThrow(/Not enough credits/);
    await expect(attempt([-1, 1], 'signup:user:' + uid)).rejects.toThrow(/already used/);
    expect((await wallet()).balance.credits).toBe(100);
  });
});

describe('immutable, auditable ledger', () => {
  it('the database refuses UPDATE, DELETE and TRUNCATE', async () => {
    const t = (await h.rt.db.query(`SELECT id FROM credit_transactions LIMIT 1`)).rows[0].id;
    await expect(h.rt.db.query(`UPDATE credit_entries SET amount = amount * 10`)).rejects.toThrow(/append-only/);
    await expect(h.rt.db.query(`UPDATE credit_transactions SET memo = 'x' WHERE id = $1`, [t])).rejects.toThrow(/append-only/);
    await expect(h.rt.db.query(`DELETE FROM credit_entries`)).rejects.toThrow(/append-only/);
    await expect(h.rt.db.query(`DELETE FROM credit_transactions`)).rejects.toThrow(/append-only/);
    await expect(h.rt.db.query(`DELETE FROM credit_wallets`)).rejects.toThrow(/append-only/);
    await expect(h.rt.db.query(`TRUNCATE credit_entries CASCADE`)).rejects.toThrow(/append-only/);
    expect((await wallet()).balance.credits).toBe(100);
  });

  it('raw SQL cannot commit an unbalanced transaction or a negative balance', async () => {
    const uid = await userId(op);
    const { u, c } = await withTx(h.rt.db, async (cl) => {
      const l = new Ledger(cl);
      return { u: await l.userWallet(uid), c: await l.systemWallet('consumption') };
    });
    const raw = (amountUser: number, amountSink: number) =>
      withTx(h.rt.db, async (cl) => {
        const tx = randomUUID();
        await cl.query(
          `INSERT INTO credit_transactions (id, kind, idempotency_key, actor_type, memo, created_at, prev_hash, hash)
           VALUES ($1, 'settlement', $2, 'system', 'raw', now(), 'x', $2)`,
          [tx, `raw-${tx}`],
        );
        await cl.query(`INSERT INTO credit_entries (transaction_id, wallet_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)`, [
          tx,
          u,
          amountUser,
          c,
          amountSink,
        ]);
      });
    await expect(raw(-5, 4)).rejects.toThrow(/unbalanced/);
    await expect(raw(-200_000, 200_000)).rejects.toThrow(/negative/);
    await expect(raw(0, 0)).rejects.toThrow(/check constraint/);
    expect((await wallet()).balance.credits).toBe(100);
  });

  it('verify recomputes the hash chain and detects tampering', async () => {
    const { w, a } = await runJob(op, smallJob);
    await ranFor(a, 30);
    await post(w, `/v1/worker/assignments/${a}/result`, { status: 'completed', output: { ok: 1 }, outputSha256: sha({ ok: 1 }) });
    const ok = await verify();
    expect(ok).toMatchObject({ ok: true, problems: [] });
    expect(ok.transactions).toBeGreaterThanOrEqual(4); // 2 signups, hold, earning, settlement

    const ledger = (await get('/v1/credits/ledger', h.adminToken)).json().items;
    for (let i = 1; i < ledger.length; i++) expect(ledger[i].prevHash).toBe(ledger[i - 1].hash);
    expect(ledger.map((t: { kind: string }) => t.kind)).toEqual(['grant', 'grant', 'hold', 'earning', 'settlement']);

    // Someone with superuser rights bypasses the triggers and edits history.
    await h.rt.db.query(`ALTER TABLE credit_entries DISABLE TRIGGER credit_entries_immutable`);
    try {
      await h.rt.db.query(
        `UPDATE credit_entries SET amount = amount + 1 WHERE transaction_id = (SELECT id FROM credit_transactions WHERE kind = 'hold')
           AND amount > 0`,
      );
    } finally {
      await h.rt.db.query(`ALTER TABLE credit_entries ENABLE TRIGGER credit_entries_immutable`);
    }
    const bad = await verify();
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/hash does not match/);
    expect(bad.problems.join('\n')).toMatch(/unbalanced/);
    // Leave a consistent ledger behind for reset (TRUNCATE is allowed there).
  });

  it('every grant and withdrawal is also in the audit log', async () => {
    const uid = await userId(op);
    await grant({ userId: uid, amount: 1, reason: 'thanks', idempotencyKey: 'audit-grant-xxxx' });
    const a = await h.rt.db.query(`SELECT action, target_id, details FROM audit_log WHERE action LIKE 'credits.%'`);
    expect(a.rows).toEqual([{ action: 'credits.grant', target_id: uid, details: { amount: 1000, transactionId: expect.any(String) } }]);
    const summary = (await get('/v1/credits/summary', h.adminToken)).json();
    expect(summary).toMatchObject({ issued: { credits: 201 }, inEscrow: { credits: 0 }, consumed: { credits: 0 } });
  });
});
