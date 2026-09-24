import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HW, auth, heartbeat, reset, setup, type Harness, type TestWorker } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import {
  DEFAULT_OFFER,
  maxAttemptCost,
  minutesLeft,
  offerInputSchema,
  offerRejects,
  priceRate,
  STANDARD_PRICE,
} from '../src/market/offer.js';
import { computeReputation, type ReputationMetrics } from '../src/market/reputation.js';

const RES = { cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 };

describe('offers (pure)', () => {
  it('prices the reserved resources with the provider price', () => {
    expect(priceRate(STANDARD_PRICE, RES)).toBe(1125);
    expect(priceRate({ cpuCore: 500, ramGb: 0, gpu: 0, vramGb: 0 }, { ...RES, cpuCores: 4 })).toBe(2000);
    expect(maxAttemptCost(1125, 3600)).toBe(67_500);
  });

  it('availability windows in the provider time zone, including across midnight', () => {
    // 2026-09-24 is a Thursday (4). São Paulo is UTC−3.
    const at = (iso: string) => new Date(iso);
    const evenings = { timezone: 'America/Sao_Paulo', windows: [{ days: [1, 2, 3, 4, 5], start: '18:00', end: '23:00' }] };
    expect(minutesLeft({ timezone: 'UTC', windows: [] }, at('2026-09-24T12:00:00Z'))).toBe(Infinity);
    expect(minutesLeft(evenings, at('2026-09-24T22:00:00Z'))).toBe(240); // 19:00 local
    expect(minutesLeft(evenings, at('2026-09-24T15:00:00Z'))).toBe(0); // 12:00 local
    expect(minutesLeft(evenings, at('2026-09-26T22:00:00Z'))).toBe(0); // Saturday
    const nights = { timezone: 'UTC', windows: [{ days: [3], start: '22:00', end: '06:00' }] }; // Wed night
    expect(minutesLeft(nights, at('2026-09-23T23:00:00Z'))).toBe(420);
    expect(minutesLeft(nights, at('2026-09-24T02:00:00Z'))).toBe(240); // Thursday early morning
    expect(minutesLeft(nights, at('2026-09-24T23:00:00Z'))).toBe(0); // Thursday night: not offered
  });

  it('provider terms: listing, limits, and the whole attempt inside the window', () => {
    const now = new Date('2026-09-24T22:00:00Z'); // 19:00 in São Paulo, 240 min left
    const job = { type: 'benchmark', resources: RES, timeoutSeconds: 3600 };
    expect(offerRejects(DEFAULT_OFFER, job, 0, now)).toBeNull();
    expect(offerRejects({ ...DEFAULT_OFFER, listed: false }, job, 0, now)).toBe('NOT_LISTED');
    const limits = (l: object) => offerRejects({ ...DEFAULT_OFFER, limits: l }, job, 1, now);
    expect(limits({ maxCpuCores: 0.5 })).toBe('PROVIDER_LIMITS');
    expect(limits({ maxRamMb: 256 })).toBe('PROVIDER_LIMITS');
    expect(limits({ maxJobSeconds: 600 })).toBe('PROVIDER_LIMITS');
    expect(limits({ maxConcurrent: 1 })).toBe('PROVIDER_LIMITS');
    expect(limits({ workloadTypes: ['image-inference'] })).toBe('PROVIDER_LIMITS');
    expect(offerRejects({ ...DEFAULT_OFFER, limits: { allowGpu: false } }, job, 0, now, true)).toBe('PROVIDER_LIMITS');
    const evenings = { ...DEFAULT_OFFER, availability: { timezone: 'America/Sao_Paulo', windows: [{ days: [4], start: '18:00', end: '23:00' }] } };
    expect(offerRejects(evenings, job, 0, now)).toBeNull();
    expect(offerRejects(evenings, { ...job, timeoutSeconds: 5 * 3600 }, 0, now)).toBe('OUTSIDE_AVAILABILITY');
    expect(offerRejects(evenings, job, 0, new Date('2026-09-24T12:00:00Z'))).toBe('OUTSIDE_AVAILABILITY');
  });

  it.each([
    [{ price: { cpuCore: -1, ramGb: 0, gpu: 0, vramGb: 0 } }],
    [{ price: { cpuCore: 0, ramGb: 0, gpu: 0, vramGb: 0 } }],
    [{ price: { cpuCore: 101, ramGb: 0, gpu: 0, vramGb: 0 } }],
    [{ price: { cpuCore: 0.0001, ramGb: 0, gpu: 0, vramGb: 0 } }],
    [{ price: { cpuCore: 1 } }],
    [{ availability: { timezone: 'Mars/Olympus', windows: [] } }],
    [{ availability: { timezone: 'UTC', windows: [{ days: [1], start: '25:00', end: '26:00' }] } }],
    [{ availability: { timezone: 'UTC', windows: [{ days: [7], start: '08:00', end: '09:00' }] } }],
    [{ availability: { timezone: 'UTC', windows: [{ days: [1], start: '08:00', end: '08:00' }] } }],
    [{ limits: { maxJobSeconds: 1 } }],
    [{ reputation: 1000 }],
    [{ rating: 5 }],
  ])('rejects invalid offer %j', (bad) => {
    expect(offerInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('reputation (pure, objective)', () => {
  const base: ReputationMetrics = { completed: 0, failed: 0, uptimeMinutes: 0, uptimeWindowMinutes: 10_080, avgResponseSeconds: null, customers: 0 };
  const score = (m: Partial<ReputationMetrics>) => computeReputation({ ...base, ...m }).score;

  it('uses only completed jobs, failure rate, uptime and response time', () => {
    const r = computeReputation({ ...base, completed: 99, failed: 1, uptimeMinutes: 5040, avgResponseSeconds: 2, customers: 7 });
    expect(r.components).toEqual({ reliability: 0.98, uptime: 0.5, responsiveness: 0.833, experience: 0.667 });
    expect(r.score).toBe(Math.round(1000 * (0.4 * 0.98 + 0.25 * 0.5 + 0.15 * 0.833 + 0.2 * 0.667)));
    expect(r.metrics).toMatchObject({ failureRate: 0.01, uptime: 0.5 });
    expect(computeReputation({ ...base, completed: 99, failed: 1, uptimeMinutes: 5040, avgResponseSeconds: 2, customers: 7 })).toEqual(r);
    expect(score({})).toBe(275);
  });

  it('moves the right way with each metric', () => {
    expect(score({ completed: 50 })).toBeGreaterThan(score({ completed: 5 }));
    expect(score({ completed: 50, failed: 10 })).toBeLessThan(score({ completed: 50 }));
    expect(score({ uptimeMinutes: 10_080 })).toBeGreaterThan(score({ uptimeMinutes: 1000 }));
    expect(score({ avgResponseSeconds: 1 })).toBeGreaterThan(score({ avgResponseSeconds: 60 }));
    expect(score({ completed: 1_000_000, uptimeMinutes: 10_080, avgResponseSeconds: 0 })).toBeLessThanOrEqual(1000);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await setup({ CREDITS_INITIAL_GRANT: '1000', SIGNUP_CREDITS: '100', SIGNUP_PER_IP_PER_HOUR: '1000' });
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
});
afterAll(() => h.close());

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const req = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: object) =>
  h.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

async function signup(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email } });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json() as { userId: string; token: string };
}

/** A provider registers a computer with its own enrollment token, then it heartbeats. */
async function providerWorker(token: string, name: string, hb: object = {}): Promise<TestWorker> {
  const t = (await req('POST', '/v1/provider/enrollment-tokens', token, {})).json().token;
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/workers/register',
    payload: { enrollmentToken: t, name, hardware: HW, maxConcurrentTasks: 2 },
  });
  if (reg.statusCode !== 201) throw new Error(reg.body);
  const { workerId, workerSecret } = reg.json();
  const a = await h.app.inject({ method: 'POST', url: '/v1/workers/auth', payload: { workerId, workerSecret } });
  const w = { id: workerId, secret: workerSecret, token: a.json().accessToken };
  await heartbeat(h, w, hb);
  return w;
}

const setOffer = (token: string, w: TestWorker, body: object) => req('PUT', `/v1/provider/workers/${w.id}/offer`, token, body);
const job = (token: string, over: object = {}) =>
  req('POST', '/v1/jobs', token, { type: 'benchmark', input: { kind: 'primes', size: 1000, iterations: 1 }, timeout: 600, ...over });
const wpost = (w: TestWorker, url: string, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers: auth(w.token), ...(payload ? { payload } : {}) });

async function runOn(w: TestWorker, seconds: number) {
  const [a] = (await heartbeat(h, w)).json().assignments;
  await wpost(w, `/v1/worker/assignments/${a.assignmentId}/accept`);
  await h.rt.db.query(`UPDATE job_assignments SET started_at = now() - make_interval(secs => $2) WHERE id = $1`, [a.assignmentId, seconds]);
  await wpost(w, `/v1/worker/assignments/${a.assignmentId}/result`, { status: 'completed', output: { ok: 1 }, outputSha256: sha({ ok: 1 }) });
  return a.assignmentId as string;
}

/** Completed history for a worker, from jobs of `customerId` (bypasses the API on purpose). */
async function history(workerId: string, customerId: string, completed: number, failed = 0) {
  for (let i = 0; i < completed + failed; i++) {
    const j = await h.rt.db.query(
      `INSERT INTO jobs (owner_id, type, resources, timeout_seconds, input, status) VALUES ($1, 'benchmark', $2, 600, '{}', 'COMPLETED') RETURNING id`,
      [customerId, RES],
    );
    await h.rt.db.query(
      `INSERT INTO job_assignments (job_id, worker_id, attempt, status, strategy, score, score_detail, reserved, accept_deadline,
                                    assigned_at, started_at, finished_at)
       VALUES ($1, $2, 1, $3, 's', 0, '{}', $4, now(), now() - interval '10 minutes', now() - interval '10 minutes' + interval '2 seconds', now())`,
      [j.rows[0].id, workerId, i < completed ? 'completed' : 'failed', RES],
    );
  }
}

describe('accounts and isolation', () => {
  it('anyone can sign up as a member with a small grant; duplicates and closed sign-up are refused', async () => {
    const a = await signup('alice@ex.test');
    const w = (await req('GET', '/v1/credits/wallet', a.token)).json();
    expect(w.balance.credits).toBe(100);
    const dup = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'ALICE@ex.test' } });
    expect(dup.statusCode).toBe(409);
    const bad = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'x@y.z', role: 'admin' } });
    expect(bad.statusCode).toBe(400);
    h.rt.config.OPEN_SIGNUP = false;
    try {
      const closed = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'bob@ex.test' } });
      expect(closed.statusCode).toBe(403);
    } finally {
      h.rt.config.OPEN_SIGNUP = true;
    }
  });

  it('members see only their own jobs and computers, never platform-wide data', async () => {
    const a = await signup('a@ex.test');
    const b = await signup('b@ex.test');
    const ja = (await job(a.token)).json();
    const jb = (await job(b.token)).json();
    const wa = await providerWorker(a.token, 'a-pc');

    expect((await req('GET', `/v1/jobs/${jb.id}`, a.token)).statusCode).toBe(404);
    expect((await req('GET', `/v1/jobs/${jb.id}/events`, a.token)).statusCode).toBe(404);
    expect((await req('GET', `/v1/jobs/${jb.id}/decisions`, a.token)).statusCode).toBe(404);
    expect((await req('POST', `/v1/jobs/${jb.id}/cancel`, a.token, {})).statusCode).toBe(404);
    const list = (await req('GET', `/v1/jobs?owner=${b.userId}`, a.token)).json();
    expect(list.items.map((j: { id: string }) => j.id)).toEqual([ja.id]);
    expect((await req('GET', `/v1/jobs/${ja.id}`, a.token)).json().budget).toBe(11.25);

    expect((await setOffer(b.token, wa, { listed: false })).statusCode).toBe(404);
    expect((await req('GET', `/v1/credits/workers/${wa.id}/wallet`, b.token)).statusCode).toBe(404);
    expect((await req('GET', '/v1/provider/workers', b.token)).json().items).toEqual([]);
    expect((await req('GET', '/v1/provider/workers', a.token)).json().items.map((w: { id: string }) => w.id)).toEqual([wa.id]);

    for (const url of ['/v1/workers', `/v1/workers/${wa.id}`, `/v1/workers/${wa.id}/profile`, '/v1/dashboard/overview', '/v1/credits/ledger'])
      expect((await req('GET', url, a.token)).statusCode, url).toBe(403);
    expect((await req('POST', '/v1/admin/enrollment-tokens', a.token, {})).statusCode).toBe(403);

    const ws = await h.app.injectWS('/v1/ws', { headers: auth(a.token) });
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4003);
  });

  it('the public listing shows terms and reputation, never owners or usage', async () => {
    const p = await signup('p@ex.test');
    const w = await providerWorker(p.token, 'rig');
    await setOffer(p.token, w, { price: { cpuCore: 0.5, ramGb: 0.1, gpu: 2, vramGb: 0.1 } });
    const c = await signup('c@ex.test');
    const offers = (await req('GET', '/v1/market/offers', c.token)).json();
    expect(offers.items).toHaveLength(1);
    const o = offers.items[0];
    expect(o).toMatchObject({ workerId: w.id, name: 'rig', offer: { pricePerMinute: { cpuCore: 0.5, ramGb: 0.1, gpu: 2, vramGb: 0.1 } } });
    expect(o.reputation.score).toBeGreaterThan(0);
    const text = JSON.stringify(o);
    for (const secret of [p.userId, 'p@ex.test', 'cpuPercent', 'owner', 'secret', 'lastUsage']) expect(text).not.toContain(secret);
    await setOffer(p.token, w, { listed: false });
    expect((await req('GET', '/v1/market/offers', c.token)).json().items).toEqual([]);
  });
});

describe('matching: requirements + capabilities + price + reliability', () => {
  it('the customer pays the provider its own price; the provider receives it and can withdraw', async () => {
    const p = await signup('p@ex.test');
    const c = await signup('c@ex.test');
    const w = await providerWorker(p.token, 'rig');
    // 2 credits per core-minute, nothing for RAM: 1 core × 10 min = 20 credits.
    expect((await setOffer(p.token, w, { price: { cpuCore: 2, ramGb: 0, gpu: 0, vramGb: 0 } })).statusCode).toBe(200);
    const j = (await job(c.token, { budget: 25 })).json();
    expect(j.budget).toBe(25);
    expect((await req('GET', '/v1/credits/wallet', c.token)).json().balance.credits).toBe(75);

    const engine = createEngine(h.rt);
    expect((await engine.tick()).assigned).toBe(1);
    const aId = await runOn(w, 600);
    // Price changes after the assignment never touch it.
    await setOffer(p.token, w, { price: { cpuCore: 50, ramGb: 0, gpu: 0, vramGb: 0 } });

    const spend = (await req('GET', '/v1/credits/spending', c.token)).json().items[0];
    expect(spend.attempts[0]).toMatchObject({ assignmentId: aId, workerId: w.id, ratePerMinute: 2000 });
    expect(spend.paid.credits).toBeGreaterThanOrEqual(20);
    expect(spend.paid.credits).toBeLessThan(20.1);
    const cw = (await req('GET', '/v1/credits/wallet', c.token)).json();
    expect(cw.balance.milli).toBe(100_000 - spend.paid.milli);

    const earn = (await req('GET', '/v1/credits/earnings', p.token)).json();
    expect(earn.byWorker).toEqual([{ workerId: w.id, name: 'rig', payments: 1, total: spend.paid }]);
    const wd = await req('POST', `/v1/credits/workers/${w.id}/withdraw`, p.token, { amount: 20, idempotencyKey: 'first-withdrawal' });
    expect(wd.statusCode).toBe(201);
    expect((await req('GET', '/v1/credits/wallet', p.token)).json().balance.credits).toBe(120);
    expect((await req('GET', '/v1/credits/ledger/verify', h.adminToken)).json()).toMatchObject({ ok: true });
  });

  it('with everything else equal, the cheaper provider wins and the reason says so', async () => {
    const p1 = await signup('p1@ex.test');
    const p2 = await signup('p2@ex.test');
    const c = await signup('c@ex.test');
    const cheap = await providerWorker(p1.token, 'cheap');
    const pricey = await providerWorker(p2.token, 'pricey');
    await setOffer(p1.token, cheap, { price: { cpuCore: 0.5, ramGb: 0.25, gpu: 4, vramGb: 0.25 } });
    await setOffer(p2.token, pricey, { price: { cpuCore: 1.5, ramGb: 0.25, gpu: 4, vramGb: 0.25 } });
    const j = (await job(c.token, { budget: 50 })).json();
    await createEngine(h.rt).tick();
    const got = (await req('GET', `/v1/jobs/${j.id}`, c.token)).json();
    expect(got.workerId).toBe(cheap.id);
    expect(got.placementReason).toMatch(/melhor preço e encaixe \(0,63 créditos\/min vs 1,63 créditos\/min/);
  });

  it('a provider with a better objective track record beats an equal price', async () => {
    const p1 = await signup('p1@ex.test');
    const p2 = await signup('p2@ex.test');
    const c = await signup('c@ex.test');
    const other = await signup('other@ex.test');
    const good = await providerWorker(p1.token, 'good');
    const flaky = await providerWorker(p2.token, 'flaky');
    await history(good.id, other.userId, 30);
    await history(flaky.id, other.userId, 10, 10);
    const j = (await job(c.token)).json();
    await createEngine(h.rt).tick();
    const got = (await req('GET', `/v1/jobs/${j.id}`, c.token)).json();
    expect(got.workerId).toBe(good.id);
    expect(got.placementReason).toMatch(/reputação maior \(\d+ vs \d+; 30 jobs concluídos, falhas 0%/);
    const rep = (await req('GET', `/v1/market/workers/${flaky.id}/reputation`, c.token)).json();
    expect(rep.metrics).toMatchObject({ completed: 10, failed: 10, failureRate: 0.5, avgResponseSeconds: 2 });
  });

  it('budget, provider limits, availability, listing and minimum reputation are hard constraints', async () => {
    const p = await signup('p@ex.test');
    const c = await signup('c@ex.test');
    const w = await providerWorker(p.token, 'rig');
    const engine = createEngine(h.rt);
    const pending = async (over: object) => {
      const j = (await job(c.token, over)).json();
      await engine.tick();
      const got = (await req('GET', `/v1/jobs/${j.id}`, c.token)).json();
      await req('POST', `/v1/jobs/${j.id}/cancel`, c.token, {});
      return got;
    };
    // 10 min at 1.125/min = 11.25 at most; a budget of 5 cannot cover it.
    expect((await pending({ budget: 5 })).pendingReason).toBe('no eligible worker (1× OVER_BUDGET)');
    expect((await pending({ requirements: { minReputation: 900 } })).pendingReason).toBe('no eligible worker (1× LOW_REPUTATION)');
    await setOffer(p.token, w, { limits: { maxJobSeconds: 300 } });
    expect((await pending({})).pendingReason).toBe('no eligible worker (1× PROVIDER_LIMITS)');
    await setOffer(p.token, w, { limits: {}, availability: { timezone: 'UTC', windows: [{ days: [((new Date().getUTCDay() + 3) % 7)], start: '00:00', end: '23:59' }] } });
    expect((await pending({})).pendingReason).toBe('no eligible worker (1× OUTSIDE_AVAILABILITY)');
    await setOffer(p.token, w, { availability: { timezone: 'UTC', windows: [] }, listed: false });
    expect((await pending({})).pendingReason).toBe('no eligible worker (1× NOT_LISTED)');
    await setOffer(p.token, w, { listed: true });
    const ok = await pending({ budget: 12 });
    expect(ok.status).toBe('ASSIGNED');
  });

  it('quotes use the scheduler rules without creating anything', async () => {
    const p = await signup('p@ex.test');
    const c = await signup('c@ex.test');
    const w = await providerWorker(p.token, 'rig');
    await setOffer(p.token, w, { price: { cpuCore: 2, ramGb: 0, gpu: 0, vramGb: 0 } });
    const q = (await req('POST', '/v1/market/quote', c.token, { type: 'benchmark', timeout: 600, budget: 30 })).json();
    expect(q).toMatchObject({ budget: 30, eligible: 1, bestMatch: { workerId: w.id, pricePerMinute: 2, maxCost: 20 }, cheapestMaxCost: 20 });
    const tight = (await req('POST', '/v1/market/quote', c.token, { type: 'benchmark', timeout: 600, budget: 10 })).json();
    expect(tight).toMatchObject({ eligible: 0, bestMatch: null, candidates: [{ workerId: w.id, reason: 'OVER_BUDGET' }] });
    expect((await h.rt.db.query(`SELECT count(*)::int AS n FROM jobs`)).rows[0].n).toBe(0);
    expect((await req('GET', '/v1/credits/wallet', c.token)).json().balance.credits).toBe(100);
  });
});

describe('reputation cannot be manipulated', () => {
  it('there is no way to rate, review or set reputation', async () => {
    const p = await signup('p@ex.test');
    const w = await providerWorker(p.token, 'rig');
    const c = await signup('c@ex.test');
    const before = (await req('GET', `/v1/market/workers/${w.id}/reputation`, c.token)).json().score;
    for (const [method, url, body] of [
      ['POST', `/v1/market/workers/${w.id}/reputation`, { score: 1000 }],
      ['PUT', `/v1/market/workers/${w.id}/reputation`, { score: 1000 }],
      ['POST', `/v1/market/workers/${w.id}/reviews`, { stars: 5 }],
      ['POST', `/v1/market/workers/${w.id}/rating`, { stars: 5 }],
    ] as const)
      expect((await req(method, url, c.token, body)).statusCode, url).toBe(404);
    expect((await setOffer(p.token, w, { reputation: 1000 })).statusCode).toBe(400);
    // Unknown heartbeat fields are dropped by the schema: nothing a worker reports is a reputation input.
    await heartbeat(h, w, { reputation: 1000, completedJobs: 9999, failureRate: 0 });
    expect((await req('GET', `/v1/market/workers/${w.id}/reputation`, c.token)).json().score).toBe(before);
  });

  it('jobs a provider sends to its own computer never count', async () => {
    const p = await signup('p@ex.test');
    const w = await providerWorker(p.token, 'rig');
    const engine = createEngine(h.rt);
    for (let i = 0; i < 3; i++) {
      await job(p.token);
      await engine.tick();
      await runOn(w, 5);
    }
    const rep = (await req('GET', `/v1/market/workers/${w.id}/reputation`, p.token)).json();
    expect(rep.metrics).toMatchObject({ completed: 0, failed: 0, customers: 0 });

    const c = await signup('c@ex.test');
    await job(c.token);
    await createEngine(h.rt).tick();
    await runOn(w, 5);
    const after = (await req('GET', `/v1/market/workers/${w.id}/reputation`, c.token)).json();
    expect(after.metrics).toMatchObject({ completed: 1, failed: 0, customers: 1 });
    expect(after.score).toBeGreaterThan(rep.score);
  });
});

describe('limits of the open platform', () => {
  it('the owner still stops sharing immediately: a paused computer gets nothing', async () => {
    const p = await signup('p@ex.test');
    const c = await signup('c@ex.test');
    const w = await providerWorker(p.token, 'rig');
    await heartbeat(h, w, { state: 'paused' });
    const j = (await job(c.token)).json();
    await createEngine(h.rt).tick();
    expect((await req('GET', `/v1/jobs/${j.id}`, c.token)).json().pendingReason).toBe('no eligible worker (1× NOT_ACCEPTING)');
  });

  it('only registered workload types exist for customers too', async () => {
    const c = await signup('c@ex.test');
    const r = await req('POST', '/v1/jobs', c.token, { type: 'shell', input: { cmd: 'whoami' } });
    expect(r.statusCode).toBe(400);
  });
});
