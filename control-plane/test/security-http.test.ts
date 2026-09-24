// HTTP-level controls: rate limits, proxy trust, security headers, TLS, request ids,
// body limits. Low limits on purpose (own harness).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, reset, setup, type Harness } from './helpers.js';
import { buildApp } from '../src/app.js';
import { createUserWithToken } from '../src/modules/admin/service.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ RATE_LIMIT_PER_MINUTE: '30', SIGNUP_PER_IP_PER_HOUR: '3', TRUST_PROXY: 'false', MAX_BODY_BYTES: '65536' });
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
});
afterAll(() => h.close());

const signup = (email: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email }, headers, remoteAddress: '203.0.113.7' });

describe('API abuse and DDoS', () => {
  it('every route is rate limited per credential; other credentials are unaffected', async () => {
    const a = (await createUserWithToken(h.rt, { email: 'x@ex.test', role: 'member', tokenName: 't' }, null)).token;
    const b = (await createUserWithToken(h.rt, { email: 'y@ex.test', role: 'member', tokenName: 't' }, null)).token;
    const codes = [];
    for (let i = 0; i < 35; i++) codes.push((await h.app.inject({ url: '/v1/credits/wallet', headers: auth(a) })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
    expect((await h.app.inject({ url: '/v1/credits/wallet', headers: auth(b) })).statusCode).toBe(200);
    // Health checks are never limited (load balancers poll them).
    for (let i = 0; i < 40; i++) expect((await h.app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('without a credential the limit is per IP, and a forged X-Forwarded-For does not change the IP', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await signup(`u${i}@ex.test`, { 'x-forwarded-for': `198.51.100.${i}` })).statusCode);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    // Unauthenticated floods on any route hit the global per-IP limit too.
    const flood = [];
    for (let i = 0; i < 35; i++)
      flood.push((await h.app.inject({ url: '/v1/nothing-here', remoteAddress: '203.0.113.99', headers: { 'x-forwarded-for': `10.0.0.${i}` } })).statusCode);
    expect(flood.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5);
  });

  it('bodies over the limit are refused before parsing', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(h.adminToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'benchmark', input: { kind: 'hash', iterations: 1 }, pad: 'x'.repeat(70_000) }),
    });
    expect(r.statusCode).toBe(413);
  });

  it('slow clients are cut off (request and connection timeouts are set)', () => {
    expect(h.app.server.requestTimeout).toBe(h.rt.config.REQUEST_TIMEOUT_MS);
    expect(h.app.initialConfig.connectionTimeout).toBe(h.rt.config.REQUEST_TIMEOUT_MS);
    expect(h.app.server.keepAliveTimeout).toBe(10_000);
    expect(h.rt.config.REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('headers, request ids and TLS', () => {
  it('API responses carry no-store, nosniff, no framing and a locked-down CSP', async () => {
    const r = await h.app.inject({ url: '/v1/credits/wallet', headers: auth(h.adminToken) });
    expect(r.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  it('caller request ids are accepted only when short and plain (no log injection)', async () => {
    const ok = await h.app.inject({ url: '/healthz', headers: { 'x-request-id': 'abc-123' } });
    expect(ok.headers['x-request-id']).toBe('abc-123');
    for (const bad of ['a\nb', 'x'.repeat(65), '<script>', 'a b']) {
      const r = await h.app.inject({ url: '/healthz', headers: { 'x-request-id': bad } });
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('REQUIRE_TLS refuses plain HTTP (health checks excepted) and sends HSTS', async () => {
    const cfg = { ...h.rt.config, REQUIRE_TLS: true, TRUST_PROXY: ['127.0.0.1'] as string[] };
    const app = await buildApp({ ...h.rt, config: cfg });
    await app.ready();
    try {
      const plain = await app.inject({ url: '/v1/credits/wallet', headers: auth(h.adminToken) });
      expect(plain.statusCode).toBe(403);
      expect(plain.json().error.code).toBe('TLS_REQUIRED');
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
      // Behind the trusted TLS proxy (127.0.0.1), X-Forwarded-Proto is believed.
      const viaProxy = await app.inject({ url: '/v1/credits/wallet', headers: { ...auth(h.adminToken), 'x-forwarded-proto': 'https' } });
      expect(viaProxy.statusCode).toBe(200);
      expect(viaProxy.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      // From anywhere else it is not.
      const spoof = await app.inject({
        url: '/v1/credits/wallet',
        headers: { ...auth(h.adminToken), 'x-forwarded-proto': 'https' },
        remoteAddress: '203.0.113.5',
      });
      expect(spoof.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('error responses leak nothing internal', () => {
  it('unknown routes and malformed JSON give generic, structured errors', async () => {
    const nf = await h.app.inject({ url: '/v1/../../etc/passwd' });
    expect(nf.statusCode).toBe(404);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(h.adminToken), 'content-type': 'application/json' },
      payload: '{"type":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at \w+ \(|node_modules|\/home\//);
  });
});
