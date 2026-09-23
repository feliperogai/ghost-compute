import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(() => h.close());

describe('health', () => {
  it('reports ready', async () => {
    const res = await h.app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns structured 404', async () => {
    const res = await h.app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('user auth & RBAC', () => {
  it('rejects missing and invalid tokens', async () => {
    const url = '/v1/admin/enrollment-tokens';
    expect((await h.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    const bad = await h.app.inject({ method: 'POST', url, payload: {}, headers: auth('ghu_bogus') });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('UNAUTHORIZED');
  });

  it('forbids non-admins from admin routes', async () => {
    const op = await makeUser(h, 'operator');
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/enrollment-tokens',
      headers: auth(op),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('validates payloads', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: auth(h.adminToken),
      payload: { email: 'not-an-email', role: 'root' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects duplicate users', async () => {
    await makeUser(h, 'viewer', 'dup@ghost.test');
    await expect(makeUser(h, 'viewer', 'dup@ghost.test')).rejects.toThrow(/already exists/);
  });

  it('issues enrollment tokens and audits it', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/enrollment-tokens',
      headers: auth(h.adminToken),
      payload: { ttlSeconds: 600, note: 'lab pc' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^ghe_/);
    const { rows } = await h.rt.db.query(`SELECT action FROM audit_log WHERE action = 'enrollment_token.create'`);
    expect(rows).toHaveLength(1);
  });

  it('rejects revoked tokens', async () => {
    const tok = await makeUser(h, 'viewer', 'rev@ghost.test');
    await h.rt.db.query(`UPDATE api_tokens SET revoked_at = now()`);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/enrollment-tokens',
      headers: auth(tok),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
