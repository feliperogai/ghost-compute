import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createJob, makeUser, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';

let h: Harness;
let op: string;
let viewer: string;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  op = await makeUser(h, 'operator');
  viewer = await makeUser(h, 'viewer');
});
afterAll(() => h.close());

describe('create', () => {
  it('creates a job with one task per input and enqueues them', async () => {
    const job = await createJob(h, op, { inputs: [{ a: 1 }, { a: 2 }, { a: 3 }], priority: 80 });
    expect(job).toMatchObject({ status: 'queued', totalTasks: 3, priority: 80 });
    expect(await h.rt.queue.size()).toBe(3);

    const tasks = await h.app.inject({ url: `/v1/jobs/${job.id}/tasks`, headers: auth(viewer) });
    expect(tasks.json().items.map((t: { index: number; input: unknown }) => [t.index, t.input])).toEqual([
      [0, { a: 1 }],
      [1, { a: 2 }],
      [2, { a: 3 }],
    ]);
  });

  it('requires operator role', async () => {
    await expect(createJob(h, viewer)).rejects.toThrow(/FORBIDDEN/);
  });

  it.each([
    [{ inputs: [] }],
    [{ module: { name: 'Bad Name', version: '1.0.0' } }],
    [{ module: { name: 'ok', version: 'latest' } }],
    [{ priority: 101 }],
    [{ requirements: { gpu: true } }],
    [{ params: { blob: 'x'.repeat(70_000) } }],
  ])('rejects invalid payload %j', async (bad) => {
    await expect(createJob(h, op, bad)).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('query & history', () => {
  it('returns job with task counts', async () => {
    const job = await createJob(h, op);
    const res = await h.app.inject({ url: `/v1/jobs/${job.id}`, headers: auth(viewer) });
    expect(res.json()).toMatchObject({ id: job.id, taskCounts: { pending: 2 }, progress: 0 });
    const missing = await h.app.inject({ url: '/v1/jobs/6f1c1c2e-3b7a-4f7e-9a53-2d6a9a0c1b11', headers: auth(viewer) });
    expect(missing.statusCode).toBe(404);
  });

  it('paginates history newest first with a cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await createJob(h, op, { name: `job-${i}` })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/jobs?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await h.app.inject({ url, headers: auth(viewer) })).json();
      seen.push(...page.items.map((j: { id: string }) => j.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids.reverse());
  });

  it('filters history', async () => {
    await createJob(h, op, { module: { name: 'render', version: '2.0.0' } });
    const j = await createJob(h, op);
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${j.id}/cancel`, headers: auth(op), payload: {} });
    const byModule = await h.app.inject({ url: '/v1/jobs?module=render', headers: auth(viewer) });
    expect(byModule.json().items).toHaveLength(1);
    const byStatus = await h.app.inject({ url: '/v1/jobs?status=cancelled', headers: auth(viewer) });
    expect(byStatus.json().items.map((x: { id: string }) => x.id)).toEqual([j.id]);
    const bad = await h.app.inject({ url: '/v1/jobs?cursor=garbage', headers: auth(viewer) });
    expect(bad.statusCode).toBe(400);
  });
});

describe('cancel', () => {
  it('cancels tasks, dequeues them and is not repeatable', async () => {
    const job = await createJob(h, op);
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/cancel`,
      headers: auth(op),
      payload: { reason: 'wrong params' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'wrong params',
      cancelledTasks: 2,
      taskCounts: { cancelled: 2, pending: 0 },
    });
    expect(await h.rt.queue.size()).toBe(0);

    const again = await h.app.inject({ method: 'POST', url: `/v1/jobs/${job.id}/cancel`, headers: auth(op) });
    expect(again.statusCode).toBe(409);

    const events = await h.app.inject({ url: `/v1/jobs/${job.id}/events`, headers: auth(viewer) });
    expect(events.json().items.map((e: { type: string }) => e.type)).toEqual(['job.created', 'job.cancelled']);
  });

  it('viewer cannot cancel', async () => {
    const job = await createJob(h, op);
    const res = await h.app.inject({ method: 'POST', url: `/v1/jobs/${job.id}/cancel`, headers: auth(viewer) });
    expect(res.statusCode).toBe(403);
  });
});
