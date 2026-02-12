import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, enrollmentToken, heartbeat, HW, makeUser, registerWorker, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { WorkerService } from '../src/modules/workers/service.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
});
afterAll(() => h.close());

describe('registration', () => {
  it('registers with a valid enrollment token exactly once', async () => {
    const token = await enrollmentToken(h);
    const payload = { enrollmentToken: token, name: 'pc', hardware: HW };
    const first = await h.app.inject({ method: 'POST', url: '/v1/workers/register', payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().workerSecret).toMatch(/^ghw_/);
    const second = await h.app.inject({ method: 'POST', url: '/v1/workers/register', payload });
    expect(second.statusCode).toBe(401);
  });

  it('stores the agent device id', async () => {
    const deviceId = '0b7f6c1e-8a51-4c1f-9d2e-3f4a5b6c7d8e';
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/workers/register',
      payload: { enrollmentToken: await enrollmentToken(h), name: 'pc', hardware: HW, deviceId },
    });
    const get = await h.app.inject({ url: `/v1/workers/${res.json().workerId}`, headers: auth(h.adminToken) });
    expect(get.json().deviceId).toBe(deviceId);
  });

  it('rejects expired tokens', async () => {
    const token = await enrollmentToken(h);
    await h.rt.db.query(`UPDATE enrollment_tokens SET expires_at = now() - interval '1 second'`);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/workers/register',
      payload: { enrollmentToken: token, name: 'pc', hardware: HW },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates hardware payload', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/workers/register',
      payload: { enrollmentToken: await enrollmentToken(h), name: 'pc', hardware: { cpu: {} } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('never stores the raw secret', async () => {
    const w = await registerWorker(h);
    const { rows } = await h.rt.db.query(`SELECT secret_hash FROM workers WHERE id = $1`, [w.id]);
    expect(rows[0].secret_hash.toString('utf8')).not.toContain(w.secret);
  });
});

describe('authentication', () => {
  it('issues a token only for the right secret', async () => {
    const w = await registerWorker(h);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/workers/auth',
      payload: { workerId: w.id, workerSecret: 'ghw_wrongwrongwrong' },
    });
    expect(bad.statusCode).toBe(401);
    expect(w.token).toMatch(/^v1\./);
    expect((await h.app.inject({ url: '/v1/worker/me', headers: auth(w.token) })).statusCode).toBe(200);
  });

  it('does not accept user tokens on worker routes nor worker tokens on user routes', async () => {
    const w = await registerWorker(h);
    expect((await h.app.inject({ url: '/v1/worker/me', headers: auth(h.adminToken) })).statusCode).toBe(401);
    expect((await h.app.inject({ url: '/v1/workers', headers: auth(w.token) })).statusCode).toBe(401);
  });
});

describe('revocation', () => {
  it('blocks the worker immediately and is admin-only', async () => {
    const w = await registerWorker(h);
    const op = await makeUser(h, 'operator');
    const url = `/v1/workers/${w.id}/revoke`;
    expect(
      (await h.app.inject({ method: 'POST', url, headers: auth(op), payload: { reason: 'x' } })).statusCode,
    ).toBe(403);

    const res = await h.app.inject({ method: 'POST', url, headers: auth(h.adminToken), payload: { reason: 'stolen' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('revoked');

    expect((await heartbeat(h, w)).statusCode).toBe(401);
    const reauth = await h.app.inject({
      method: 'POST',
      url: '/v1/workers/auth',
      payload: { workerId: w.id, workerSecret: w.secret },
    });
    expect(reauth.json().error.code).toBe('WORKER_REVOKED');
    const again = await h.app.inject({ method: 'POST', url, headers: auth(h.adminToken), payload: { reason: 'x' } });
    expect(again.statusCode).toBe(409);
  });
});

describe('listing & status', () => {
  it('lists with filters and shows status', async () => {
    const viewer = await makeUser(h, 'viewer');
    const a = await registerWorker(h, { name: 'a' });
    await registerWorker(h, { name: 'b' });
    await heartbeat(h, a);

    const all = await h.app.inject({ url: '/v1/workers', headers: auth(viewer) });
    expect(all.json().total).toBe(2);
    const avail = await h.app.inject({ url: '/v1/workers?state=available', headers: auth(viewer) });
    expect(avail.json().items.map((w: { name: string }) => w.name)).toEqual(['a']);

    const one = await h.app.inject({ url: `/v1/workers/${a.id}`, headers: auth(viewer) });
    expect(one.json()).toMatchObject({
      id: a.id,
      state: 'available',
      online: true,
      assignments: [],
      workloadTypes: ['wasm-cpu'],
      capacity: { cpuCores: 4 },
    });
    expect(one.json().lastUsage.cpuPercent).toBe(10);

    const missing = await h.app.inject({
      url: '/v1/workers/00000000-0000-0000-0000-000000000000',
      headers: auth(viewer),
    });
    expect(missing.statusCode).toBe(404);
    expect((await h.app.inject({ url: '/v1/workers/not-a-uuid', headers: auth(viewer) })).statusCode).toBe(400);
  });
});

describe('heartbeat & offline detection', () => {
  it('updates state and reports unknown leases for cancellation', async () => {
    const w = await registerWorker(h);
    const ghost = '6f1c1c2e-3b7a-4f7e-9a53-2d6a9a0c1b11';
    const res = await heartbeat(h, w, { state: 'paused', activeAssignmentIds: [ghost] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelAssignmentIds: [ghost], assignments: [], heartbeatIntervalSeconds: 5 });
  });

  it('rejects malformed usage, capacity and workload types', async () => {
    const w = await registerWorker(h);
    expect((await heartbeat(h, w, { usage: { cpuPercent: 400, ramUsedMb: 1 } })).statusCode).toBe(400);
    expect((await heartbeat(h, w, { capacity: { cpuCores: 1 } })).statusCode).toBe(400);
    expect((await heartbeat(h, w, { workloadTypes: ['Shell; rm -rf'] })).statusCode).toBe(400);
  });

  it('marks silent workers offline and emits an event', async () => {
    const w = await registerWorker(h);
    await heartbeat(h, w);
    const svc = new WorkerService(h.rt);
    expect(await svc.detectOffline()).toEqual([]);

    const events: string[] = [];
    const off = h.rt.bus.onBroadcast((e) => events.push(e.type));
    await h.rt.db.query(`UPDATE workers SET last_seen_at = now() - interval '1 hour'`);
    expect(await svc.detectOffline()).toEqual([w.id]);
    await new Promise((r) => setTimeout(r, 50));
    off();
    expect(events).toContain('worker.offline');

    await heartbeat(h, w);
    const { rows } = await h.rt.db.query(`SELECT state FROM workers WHERE id = $1`, [w.id]);
    expect(rows[0].state).toBe('available');
  });
});
