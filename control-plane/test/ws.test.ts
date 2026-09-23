import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { auth, createJob, heartbeat, makeUser, registerWorker, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { createEngine } from '../src/jobs/runner.js';
import { WS_CLOSE } from '../src/events/ws.js';

let h: Harness;
let op: string;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
});
afterAll(() => h.close());

/** Collects messages and lets tests await one matching a predicate. */
function inbox(ws: WebSocket) {
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  return {
    msgs,
    next(pred: (m: any) => boolean, timeout = 2000) {
      const found = msgs.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise<any>((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(msgs)}`)), timeout);
      });
    },
  };
}
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));

describe('websocket', () => {
  it('authenticates users via first message and streams events', async () => {
    const ws = await h.app.injectWS('/v1/ws');
    const box = inbox(ws);
    ws.send(JSON.stringify({ type: 'auth', token: op }));
    expect(await box.next((m) => m.type === 'ready')).toMatchObject({ principal: { kind: 'user', role: 'operator' } });

    const job = await createJob(h, op);
    const ev = await box.next((m) => m.type === 'event' && m.event.type === 'job.created');
    expect(ev.event.data.job.id).toBe(job.id);
    ws.terminate();
  });

  it('authenticates via header and filters subscriptions', async () => {
    const ws = await h.app.injectWS('/v1/ws', { headers: auth(op) });
    const box = inbox(ws);
    await box.next((m) => m.type === 'ready');
    ws.send(JSON.stringify({ type: 'subscribe', types: ['worker.'] }));
    await box.next((m) => m.type === 'subscribed');
    await createJob(h, op);
    await registerWorker(h);
    await box.next((m) => m.type === 'event' && m.event.type === 'worker.registered');
    expect(box.msgs.some((m) => m.event?.type === 'job.created')).toBe(false);
    ws.terminate();
  });

  it('rejects bad tokens and malformed messages', async () => {
    const ws = await h.app.injectWS('/v1/ws');
    const box = inbox(ws);
    ws.send('not json');
    expect(await box.next((m) => m.type === 'error')).toMatchObject({ code: 'BAD_MESSAGE' });
    const code = closed(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'ghu_invalidinvalid' }));
    expect(await code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('delivers assignments and cancellations to workers, and closes on revoke', async () => {
    const w = await registerWorker(h);
    await heartbeat(h, w);
    const job = await createJob(h, op);
    // Assigned while the worker is disconnected: replayed on connect.
    await createEngine(h.rt).tick();

    const ws = await h.app.injectWS('/v1/ws', { headers: auth(w.token) });
    const box = inbox(ws);
    await box.next((m) => m.type === 'ready');
    const assigned = await box.next((m) => m.type === 'job.assigned');
    expect(assigned.assignment).toMatchObject({ jobId: job.id, type: 'benchmark' });

    const code = closed(ws);
    await h.app.inject({
      method: 'POST',
      url: `/v1/workers/${w.id}/revoke`,
      headers: auth(h.adminToken),
      payload: { reason: 'lost laptop' },
    });
    expect(await box.next((m) => m.type === 'assignment.cancel')).toMatchObject({
      assignmentId: assigned.assignment.assignmentId,
    });
    expect(await box.next((m) => m.type === 'worker.revoked')).toMatchObject({ reason: 'lost laptop' });
    expect(await code).toBe(WS_CLOSE.REVOKED);
  });

  it('workers cannot subscribe to platform events', async () => {
    const w = await registerWorker(h);
    const ws = await h.app.injectWS('/v1/ws', { headers: auth(w.token) });
    const box = inbox(ws);
    await box.next((m) => m.type === 'ready');
    ws.send(JSON.stringify({ type: 'subscribe', types: [] }));
    expect(await box.next((m) => m.type === 'error')).toMatchObject({ code: 'FORBIDDEN' });
    ws.terminate();
  });
});
