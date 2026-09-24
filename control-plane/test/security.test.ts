// Security controls against malicious providers, customers and workers
// (docs/security/AUDIT.md). HTTP-level controls: security-http.test.ts.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HW, auth, heartbeat, reset, setup, type Harness, type TestWorker } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import { resultsAgree, verdict, CONFIDENCE_TOLERANCE_BP } from '../src/jobs/verification.js';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('result verification (pure)', () => {
  const bench = (checksum: string, elapsedMs = 10) => ({ kind: 'primes', size: 1000, iterations: 1, checksum, elapsedMs, opsPerSecond: 5 });
  it('benchmark: same work and checksum agree whatever the timing; any other difference does not', () => {
    expect(resultsAgree('benchmark', bench('00a8', 10), bench('00a8', 9999))).toBe(true);
    expect(resultsAgree('benchmark', bench('00a8'), bench('00a9'))).toBe(false);
    expect(resultsAgree('benchmark', bench('00a8'), { ...bench('00a8'), size: 1001 })).toBe(false);
    expect(resultsAgree('benchmark', bench(''), bench(''))).toBe(false);
    expect(resultsAgree('shell', { a: 1 }, { a: 1 })).toBe(false); // unknown types never agree
    expect(resultsAgree('benchmark', null, null)).toBe(false);
  });

  it('inference: labels and errors must match; confidence within tolerance', () => {
    const inf = (items: object[]) => ({ items, count: items.length });
    const a = inf([{ index: 0, label: 3, confidenceBp: 8000 }, { index: 1, error: 'DECODE_ERROR' }]);
    expect(resultsAgree('image-inference', a, inf([{ index: 1, error: 'DECODE_ERROR' }, { index: 0, label: 3, confidenceBp: 8000 + CONFIDENCE_TOLERANCE_BP }]))).toBe(true);
    expect(resultsAgree('image-inference', a, inf([{ index: 0, label: 3, confidenceBp: 8000 + CONFIDENCE_TOLERANCE_BP + 1 }, { index: 1, error: 'DECODE_ERROR' }]))).toBe(false);
    expect(resultsAgree('image-inference', a, inf([{ index: 0, label: 4, confidenceBp: 8000 }, { index: 1, error: 'DECODE_ERROR' }]))).toBe(false);
    expect(resultsAgree('image-inference', a, inf([{ index: 0, label: 3, confidenceBp: 8000 }, { index: 1, label: 1, confidenceBp: 10 }]))).toBe(false);
    expect(resultsAgree('image-inference', a, inf([{ index: 0, label: 3, confidenceBp: 8000 }]))).toBe(false);
    expect(resultsAgree('image-inference', inf([]), inf([]))).toBe(false);
  });

  it('agreement needs two different owners; three disagreeing replicas are a mismatch', () => {
    const r = (id: string, owner: string, checksum: string) => ({ assignmentId: id, ownerId: owner, output: bench(checksum) });
    expect(verdict('benchmark', [r('a', 'o1', 'x')])).toEqual({ kind: 'pending' });
    expect(verdict('benchmark', [r('a', 'o1', 'x'), r('b', 'o1', 'x')])).toEqual({ kind: 'pending' });
    expect(verdict('benchmark', [r('a', 'o1', 'x'), r('b', 'o2', 'y')])).toEqual({ kind: 'pending' });
    expect(verdict('benchmark', [r('a', 'o1', 'x'), r('b', 'o2', 'y'), r('c', 'o3', 'x')])).toEqual({
      kind: 'agreed',
      winner: 'a',
      agreed: ['a', 'c'],
      disagreed: ['b'],
    });
    expect(verdict('benchmark', [r('a', 'o1', 'x'), r('b', 'o2', 'y'), r('c', 'o3', 'z')])).toEqual({
      kind: 'mismatch',
      disagreed: ['a', 'b', 'c'],
    });
  });
});

let h: Harness;
beforeAll(async () => {
  h = await setup({ CREDITS_INITIAL_GRANT: '1000', SIGNUP_CREDITS: '200', SIGNUP_PER_IP_PER_HOUR: '1000' });
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
});
afterAll(() => h.close());

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: object) =>
  h.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
async function signup(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email } });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json() as { userId: string; token: string };
}
async function providerWorker(token: string, name: string): Promise<TestWorker> {
  const t = (await req('POST', '/v1/provider/enrollment-tokens', token, {})).json().token;
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/workers/register',
    payload: { enrollmentToken: t, name, hardware: HW, maxConcurrentTasks: 2 },
  });
  const { workerId, workerSecret } = reg.json();
  const a = await h.app.inject({ method: 'POST', url: '/v1/workers/auth', payload: { workerId, workerSecret } });
  const w = { id: workerId, secret: workerSecret, token: a.json().accessToken };
  await heartbeat(h, w);
  return w;
}
const wpost = (w: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(w.token), ...(payload ? { payload } : {}) });
const job = (token: string, over: object = {}) =>
  req('POST', '/v1/jobs', token, { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, timeout: 600, ...over });
const out = (checksum: string, elapsedMs = 5) => ({ kind: 'primes', size: 1000, iterations: 1, checksum, elapsedMs, opsPerSecond: 1 });

/** The worker takes its pending offer, "runs" for `seconds`, and answers `output`. */
async function answer(w: TestWorker, output: object, seconds = 30) {
  const offers = (await heartbeat(h, w)).json().assignments;
  expect(offers, 'worker should have an offer').toHaveLength(1);
  const a = offers[0];
  await wpost(w, `/v1/worker/assignments/${a.assignmentId}/accept`);
  await h.rt.db.query(`UPDATE job_assignments SET started_at = now() - make_interval(secs => $2) WHERE id = $1`, [a.assignmentId, seconds]);
  const r = await wpost(w, `/v1/worker/assignments/${a.assignmentId}/result`, { status: 'completed', output, outputSha256: sha(output) });
  expect(r.statusCode).toBe(200);
  return a as { assignmentId: string; jobId: string; checkpoint?: unknown };
}

async function market(n: number) {
  const providers = [];
  for (let i = 0; i < n; i++) {
    const p = await signup(`p${i}@ex.test`);
    providers.push({ ...p, w: await providerWorker(p.token, `pc${i}`) });
  }
  return providers;
}
const getJob = (token: string, id: string) => req('GET', `/v1/jobs/${id}`, token).then((r) => r.json());
const walletOf = (token: string, workerId: string) =>
  req('GET', `/v1/credits/workers/${workerId}/wallet`, token).then((r) => r.json().balance.milli as number);
const reputation = (token: string, workerId: string) =>
  req('GET', `/v1/market/workers/${workerId}/reputation`, token).then((r) => r.json());

describe('malicious provider: forged results', () => {
  it('a public job is only completed when two different owners agree; nobody is paid before', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    expect(j.verification).toBe('replicate');
    const engine = createEngine(h.rt);
    await engine.tick();
    const first = (await getJob(c.token, j.id)).workerId as string;
    const [a, b] = first === p0!.w.id ? [p0!, p1!] : [p1!, p0!];
    await answer(a.w, out('00a8'));
    const mid = await getJob(c.token, j.id);
    expect(mid).toMatchObject({ status: 'QUEUED', stage: 'verifying', output: null });
    expect(await walletOf(a.token, a.w.id)).toBe(0);

    await engine.tick();
    expect((await getJob(c.token, j.id)).workerId).toBe(b.w.id);
    await answer(b.w, out('00a8', 999));
    const done = await getJob(c.token, j.id);
    expect(done).toMatchObject({ status: 'COMPLETED', output: out('00a8') });
    expect(await walletOf(a.token, a.w.id)).toBeGreaterThan(0);
    expect(await walletOf(b.token, b.w.id)).toBeGreaterThan(0);
  });

  it('a forged answer loses: a third computer breaks the tie, the forger is unpaid and loses reputation', async () => {
    const ps = await market(3);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map(ps.map((p) => [p.w.id, p]));
    const order: string[] = [];
    for (const answerFor of [out('00a8'), out('dead'), out('00a8')]) {
      await engine.tick();
      const wid = (await getJob(c.token, j.id)).workerId as string;
      order.push(wid);
      await answer(byWorker.get(wid)!.w, answerFor);
    }
    expect(new Set(order).size).toBe(3);
    const done = await getJob(c.token, j.id);
    expect(done).toMatchObject({ status: 'COMPLETED', output: out('00a8') });
    const forger = byWorker.get(order[1]!)!;
    expect(await walletOf(forger.token, forger.w.id)).toBe(0);
    for (const honest of [order[0]!, order[2]!]) expect(await walletOf(byWorker.get(honest)!.token, honest)).toBeGreaterThan(0);
    expect((await reputation(c.token, forger.w.id)).metrics).toMatchObject({ completed: 0, failed: 1 });
    expect((await reputation(c.token, order[0]!)).metrics).toMatchObject({ completed: 1, failed: 0 });
  });

  it('three different answers: the job fails with RESULT_MISMATCH and the customer gets everything back', async () => {
    const ps = await market(3);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map(ps.map((p) => [p.w.id, p]));
    for (const cs of ['0001', '0002', '0003']) {
      await engine.tick();
      await answer(byWorker.get((await getJob(c.token, j.id)).workerId)!.w, out(cs));
    }
    expect((await getJob(c.token, j.id))).toMatchObject({ status: 'FAILED', error: { code: 'RESULT_MISMATCH' } });
    const w = (await req('GET', '/v1/credits/wallet', c.token)).json();
    expect(w).toMatchObject({ balance: { credits: 200 }, held: { credits: 0 } });
    for (const p of ps) expect(await walletOf(p.token, p.w.id)).toBe(0);
  });

  it('one owner cannot confirm itself with a second computer', async () => {
    const p = await signup('p@ex.test');
    const w1 = await providerWorker(p.token, 'pc1');
    const w2 = await providerWorker(p.token, 'pc2');
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    await engine.tick();
    const first = (await getJob(c.token, j.id)).workerId;
    await answer(first === w1.id ? w1 : w2, out('00a8'));
    await engine.tick();
    const again = await getJob(c.token, j.id);
    expect(again).toMatchObject({ status: 'QUEUED', pendingReason: 'no eligible worker (2× EXCLUDED)' });
  });

  it('stalling before answering does not pay: replicas are billed at most 2× the fastest (+30 s)', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token, { timeout: 3600, budget: 150 })).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map([p0!, p1!].map((p) => [p.w.id, p]));
    await engine.tick();
    const fast = byWorker.get((await getJob(c.token, j.id)).workerId)!;
    await answer(fast.w, out('00a8'), 60);
    await engine.tick();
    const slow = byWorker.get((await getJob(c.token, j.id)).workerId)!;
    await answer(slow.w, out('00a8'), 3000);
    const s = (await req('GET', '/v1/credits/spending', c.token)).json().items[0];
    const slowPay = s.attempts.find((x: { workerId: string }) => x.workerId === slow.w.id);
    expect(slowPay.seconds).toBeGreaterThanOrEqual(3000);
    expect(slowPay.billedSeconds).toBeLessThanOrEqual(2 * 61 + 30);
    expect(slowPay.summary).toMatch(/limitado a 2× a réplica mais rápida/);
  });

  it('"this job is bad" gets a second opinion; a provider that says so falsely is penalized', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map([p0!, p1!].map((p) => [p.w.id, p]));
    await engine.tick();
    const liar = byWorker.get((await getJob(c.token, j.id)).workerId)!;
    const [a] = (await heartbeat(h, liar.w)).json().assignments;
    await wpost(liar.w, `/v1/worker/assignments/${a.assignmentId}/accept`);
    await wpost(liar.w, `/v1/worker/assignments/${a.assignmentId}/result`, { status: 'failed', error: 'bad input', retryable: false });
    expect((await getJob(c.token, j.id)).status).toBe('QUEUED');
    // The next two replicas (other owners) must agree; only one other owner exists, so
    // bring in a third provider.
    const [extra] = [await signup('p9@ex.test')];
    const w9 = await providerWorker(extra!.token, 'pc9');
    const other = [p0!, p1!].find((p) => p.w.id !== liar.w.id)!;
    for (let i = 0; i < 2; i++) {
      await engine.tick();
      const wid = (await getJob(c.token, j.id)).workerId;
      await answer(wid === other.w.id ? other.w : w9, out('00a8'));
    }
    expect((await getJob(c.token, j.id)).status).toBe('COMPLETED');
    expect((await reputation(c.token, liar.w.id)).metrics).toMatchObject({ failed: 1 });
  });

  it('a job that fails everywhere is the job\'s fault, not the providers\'', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map([p0!, p1!].map((p) => [p.w.id, p]));
    for (let i = 0; i < 2; i++) {
      await engine.tick();
      const w = byWorker.get((await getJob(c.token, j.id)).workerId)!.w;
      const [a] = (await heartbeat(h, w)).json().assignments;
      await wpost(w, `/v1/worker/assignments/${a.assignmentId}/accept`);
      await wpost(w, `/v1/worker/assignments/${a.assignmentId}/result`, { status: 'failed', error: 'bad input', retryable: false });
    }
    expect((await getJob(c.token, j.id))).toMatchObject({ status: 'FAILED', error: { code: 'JOB_FAILED' } });
    for (const p of [p0!, p1!]) expect((await reputation(c.token, p.w.id)).metrics.failed).toBe(0);
  });
});

describe('malicious customer', () => {
  it('cancelling a running job still pays the provider for the time worked', async () => {
    const [p] = await market(1);
    const c = await signup('c@ex.test');
    const j = (await job(c.token, { verification: 'none' })).json();
    await createEngine(h.rt).tick();
    const [a] = (await heartbeat(h, p!.w)).json().assignments;
    await wpost(p!.w, `/v1/worker/assignments/${a.assignmentId}/accept`);
    await h.rt.db.query(`UPDATE job_assignments SET started_at = now() - interval '300 seconds' WHERE id = $1`, [a.assignmentId]);
    await req('POST', `/v1/jobs/${j.id}/cancel`, c.token, {});
    const s = (await req('GET', '/v1/credits/spending', c.token)).json().items[0];
    expect(s.jobStatus).toBe('CANCELLED');
    expect(s.paid.credits).toBeGreaterThanOrEqual(5.625); // 5 min × 1.125
    expect(await walletOf(p!.token, p!.w.id)).toBe(s.paid.milli);
  });

  it('cannot run anything but registered workloads, oversized input or out-of-range resources', async () => {
    const c = await signup('c@ex.test');
    for (const bad of [
      { type: 'shell', input: { cmd: 'id' } },
      { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1, cmd: 'id' } },
      { type: 'benchmark', input: { kind: 'hash', iterations: 1, pad: 'x'.repeat(300_000) } },
      { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, resources: { cpuCores: 10_000 } },
      { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, timeout: 10_000_000 },
      { type: 'image-inference', input: { images: [] } },
    ]) {
      const r = await req('POST', '/v1/jobs', c.token, bad);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 80)).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
    }
  });
});

describe('data leakage between parties', () => {
  it('a replica never sees another computer\'s result or checkpoint', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token)).json();
    const engine = createEngine(h.rt);
    const byWorker = new Map([p0!, p1!].map((p) => [p.w.id, p]));
    await engine.tick();
    await answer(byWorker.get((await getJob(c.token, j.id)).workerId)!.w, out('00a8'));
    await engine.tick();
    const second = byWorker.get((await getJob(c.token, j.id)).workerId)!;
    const offer = (await heartbeat(h, second.w)).json().assignments[0];
    expect(Object.keys(offer).sort()).toEqual(['acceptBy', 'assignmentId', 'attempt', 'input', 'jobId', 'name', 'resources', 'timeoutSeconds', 'type']);
    expect(JSON.stringify(offer)).not.toContain('00a8');
  });

  it('providers and customers see only their own side', async () => {
    const [p] = await market(1);
    const c = await signup('c@ex.test');
    const j = (await job(c.token, { verification: 'none' })).json();
    await createEngine(h.rt).tick();
    // The provider cannot read the customer's job, wallet or spending through the API.
    expect((await req('GET', `/v1/jobs/${j.id}`, p!.token)).statusCode).toBe(404);
    const pw = (await req('GET', '/v1/credits/spending', p!.token)).json();
    expect(pw.items).toEqual([]);
    // The customer cannot read the provider's computer wallet or offer.
    expect((await req('GET', `/v1/credits/workers/${p!.w.id}/wallet`, c.token)).statusCode).toBe(404);
    expect((await req('GET', `/v1/provider/workers/${p!.w.id}/offer`, c.token)).statusCode).toBe(404);
    // Workers cannot use user endpoints, users cannot use worker endpoints.
    expect((await h.app.inject({ url: `/v1/jobs/${j.id}`, headers: auth(p!.w.token) })).statusCode).toBe(401);
    expect((await h.app.inject({ url: '/v1/worker/assignments', headers: auth(c.token) })).statusCode).toBe(401);
  });
});

describe('worker compromise and credential theft', () => {
  it('a provider revokes a stolen computer: its token dies at once and its jobs move', async () => {
    const [p0, p1] = await market(2);
    const c = await signup('c@ex.test');
    const j = (await job(c.token, { verification: 'none' })).json();
    await createEngine(h.rt).tick();
    const first = (await getJob(c.token, j.id)).workerId;
    const stolen = first === p0!.w.id ? p0! : p1!;
    expect((await req('POST', `/v1/provider/workers/${stolen.w.id}/revoke`, c.token, { reason: 'x' })).statusCode).toBe(404);
    expect((await req('POST', `/v1/provider/workers/${stolen.w.id}/revoke`, stolen.token, { reason: 'stolen' })).statusCode).toBe(200);
    expect((await heartbeat(h, stolen.w)).statusCode).toBe(401);
    const again = await h.app.inject({ method: 'POST', url: '/v1/workers/auth', payload: { workerId: stolen.w.id, workerSecret: stolen.w.secret } });
    expect(again.json().error.code).toBe('WORKER_REVOKED');
    expect((await getJob(c.token, j.id)).status).toBe('QUEUED');
  });

  it('public tokens expire, can be rotated and revoked; nobody else can revoke them', async () => {
    const a = await signup('a@ex.test');
    const b = await signup('b@ex.test');
    const list = (await req('GET', '/v1/me/tokens', a.token)).json().items;
    expect(list).toHaveLength(1);
    expect(list[0].current).toBe(true);
    const days = (Date.parse(list[0].expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    expect(JSON.stringify(list)).not.toMatch(/hash|ghu_/);

    const fresh = (await req('POST', '/v1/me/tokens', a.token, { name: 'laptop', ttlDays: 365 })).json();
    expect((Date.parse(fresh.expiresAt) - Date.now()) / 86_400_000).toBeLessThanOrEqual(30); // capped
    expect((await req('DELETE', `/v1/me/tokens/${list[0].id}`, b.token)).statusCode).toBe(404);
    expect((await req('DELETE', `/v1/me/tokens/${list[0].id}`, fresh.token)).statusCode).toBe(200);
    expect((await req('GET', '/v1/me', a.token)).statusCode).toBe(401);
    expect((await req('GET', '/v1/me', fresh.token)).json()).toMatchObject({ email: 'a@ex.test', role: 'member' });

    await h.rt.db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [b.userId]);
    expect((await req('GET', '/v1/me', b.token)).statusCode).toBe(401);
  });
});

describe('replay attacks', () => {
  it('replaying a result, an accept or an enrollment token changes nothing', async () => {
    const [p] = await market(1);
    const c = await signup('c@ex.test');
    const j = (await job(c.token, { verification: 'none' })).json();
    await createEngine(h.rt).tick();
    const a = await answer(p!.w, out('00a8'));
    const paid = await walletOf(p!.token, p!.w.id);
    const body = { status: 'completed', output: out('00a8'), outputSha256: sha(out('00a8')) };
    for (let i = 0; i < 3; i++) {
      expect((await wpost(p!.w, `/v1/worker/assignments/${a.assignmentId}/result`, body)).statusCode).toBe(409);
      expect((await wpost(p!.w, `/v1/worker/assignments/${a.assignmentId}/accept`)).statusCode).toBe(409);
    }
    expect(await walletOf(p!.token, p!.w.id)).toBe(paid);
    const n = await h.rt.db.query(`SELECT count(*)::int AS n FROM credit_transactions WHERE job_id = $1 AND kind = 'settlement'`, [j.id]);
    expect(n.rows[0].n).toBe(1);

    const t = (await req('POST', '/v1/provider/enrollment-tokens', p!.token, {})).json().token;
    const reg = () =>
      h.app.inject({ method: 'POST', url: '/v1/workers/register', payload: { enrollmentToken: t, name: 'x', hardware: HW, maxConcurrentTasks: 1 } });
    expect((await reg()).statusCode).toBe(201);
    expect((await reg()).statusCode).toBe(401);
  });
});

describe('resource exhaustion by one account', () => {
  it('active jobs, datasets and image storage are capped per public account, even under concurrency', async () => {
    h.rt.config.MEMBER_MAX_ACTIVE_JOBS = 5;
    h.rt.config.MEMBER_MAX_DATASETS = 2;
    h.rt.config.MEMBER_STORAGE_BYTES = 1000;
    try {
      const c = await signup('c@ex.test');
      const res = await Promise.all(Array.from({ length: 12 }, () => job(c.token, { verification: 'none', timeout: 60 })));
      expect(res.filter((r) => r.statusCode === 201)).toHaveLength(5);
      expect(res.filter((r) => r.statusCode === 429).every((r) => r.json().error.code === 'QUOTA_EXCEEDED')).toBe(true);

      const ds = await Promise.all(Array.from({ length: 4 }, (_, i) => req('POST', '/v1/datasets', c.token, { name: `d${i}` })));
      expect(ds.filter((r) => r.statusCode === 201)).toHaveLength(2);
      const id = ds.find((r) => r.statusCode === 201)!.json().id;
      const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]);
      const up = (n: number) =>
        h.app.inject({ method: 'POST', url: `/v1/datasets/${id}/images`, headers: { ...auth(c.token), 'content-type': 'image/png' }, payload: png(n) });
      expect((await up(600)).statusCode).toBe(201);
      const over = await up(600);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      h.rt.config.MEMBER_MAX_ACTIVE_JOBS = 500;
      h.rt.config.MEMBER_MAX_DATASETS = 50;
      h.rt.config.MEMBER_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
    }
  });
});
