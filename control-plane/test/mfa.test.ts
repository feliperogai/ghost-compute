// Two-step verification (TOTP): the algorithm against the RFC vectors, then the account
// flow end to end against Postgres and Redis.
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, reset, setup, type Harness } from './helpers.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  openSecret,
  otpauthUrl,
  sealSecret,
  stepAt,
  totpKey,
  TOTP_STEP_SECONDS,
} from '../src/auth/totp.js';
import { MAX_FAILURES } from '../src/modules/account/mfa.js';
import { WS_CLOSE } from '../src/events/ws.js';

describe('TOTP (pure)', () => {
  const rfc = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP vectors and the RFC 6238 SHA-1 vector', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, i) => hotp(rfc, i))).toEqual(expected);
    // RFC 6238: T = 59 s → 94287082 (8 digits); authenticator apps show the last 6.
    expect(matchTotp(rfc, '287082', 59_000)).toBe(1);
  });

  it('accepts one step of drift either way, nothing further, and only 6 digits', () => {
    const now = 1_000 * TOTP_STEP_SECONDS * 1000;
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) expect(matchTotp(rfc, hotp(rfc, s + d), now)).toBe(s + d);
    for (const d of [-2, 2]) expect(matchTotp(rfc, hotp(rfc, s + d), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345']) expect(matchTotp(rfc, bad, now)).toBeNull();
  });

  it('base32 round-trips and matches the reference encoding', () => {
    expect(base32Encode(rfc)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq')).toEqual(rfc);
    expect(() => base32Decode('GEZ1')).toThrow();
  });

  it('otpauth link for authenticator apps; secrets sealed with the server key only', () => {
    const url = new URL(otpauthUrl(rfc, 'ana@ex.test'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/ghost:ana@ex.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      issuer: 'ghost',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
    const key = totpKey('test-secret-test-secret-test-secret-1234');
    const sealed = sealSecret(rfc, key);
    expect(sealed.includes(rfc)).toBe(false);
    expect(openSecret(sealed, key)).toEqual(rfc);
    expect(() => openSecret(sealed, totpKey('another-secret-another-secret-123456'))).toThrow();
  });
});

describe('two-step verification', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  beforeEach(async () => {
    await reset(h.rt);
    h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.rt.config.REQUIRE_STAFF_MFA = false;
  });
  afterAll(() => h.close());

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: object, otp?: string) =>
    h.app.inject({ method, url, headers: { ...auth(token), ...(otp ? { 'x-ghost-otp': otp } : {}) }, ...(payload ? { payload } : {}) });

  /** Each call moves the clock one step ahead and returns that step's code (codes work once). */
  function authenticator(secret: string) {
    let step = stepAt(Date.now());
    const key = base32Decode(secret);
    return () => {
      step += 1;
      vi.spyOn(Date, 'now').mockReturnValue(step * TOTP_STEP_SECONDS * 1000 + 1000);
      return hotp(key, step);
    };
  }

  async function enroll(token: string) {
    const begin = await req('POST', '/v1/me/mfa/totp', token);
    expect(begin.statusCode).toBe(201);
    const code = authenticator(begin.json().secret);
    expect((await req('POST', '/v1/me/mfa/totp/confirm', token, { code: code() })).json()).toMatchObject({ enabled: true });
    return code;
  }

  it('turns on with a code from the app; then minting a token needs a fresh code, once', async () => {
    const begin = await req('POST', '/v1/me/mfa/totp', h.adminToken);
    expect(begin.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\/ghost%3Aa%40ghost\.test\?secret=[A-Z2-7]{32}&issuer=ghost/);
    expect((await req('GET', '/v1/me', h.adminToken)).json().mfa).toEqual({ enabled: false, mustEnroll: false });
    const code = authenticator(begin.json().secret);
    const wrong = await req('POST', '/v1/me/mfa/totp/confirm', h.adminToken, { code: '000000' });
    expect(wrong.json().error.code).toBe('MFA_INVALID');
    expect((await req('POST', '/v1/me/mfa/totp/confirm', h.adminToken, { code: code() })).json()).toMatchObject({ enabled: true });
    expect((await req('POST', '/v1/me/mfa/totp', h.adminToken)).statusCode).toBe(409); // a stolen token cannot re-enroll

    const mint = (otp?: string) => req('POST', '/v1/me/tokens', h.adminToken, { name: 'laptop' }, otp);
    expect((await mint()).json().error.code).toBe('MFA_REQUIRED');
    const c = code();
    expect((await mint(c)).statusCode).toBe(201);
    expect((await mint(c)).json().error.code).toBe('MFA_INVALID'); // replay
    expect((await mint(code())).statusCode).toBe(201);
  });

  it('every action that creates credentials or credits needs the code', async () => {
    const code = await enroll(h.adminToken);
    const member = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'm@ex.test' } });
    const actions: [string, object][] = [
      ['/v1/admin/users', { email: 'op@ghost.test', role: 'operator' }],
      ['/v1/admin/enrollment-tokens', {}],
      ['/v1/provider/enrollment-tokens', {}],
      ['/v1/credits/grants', { userId: member.json().userId, amount: 5, reason: 'test', idempotencyKey: 'grant-mfa-1' }],
    ];
    for (const [url, body] of actions) {
      const without = await req('POST', url, h.adminToken, body);
      expect(without.statusCode, url).toBe(401);
      expect(without.json().error.code, url).toBe('MFA_REQUIRED');
      expect((await req('POST', url, h.adminToken, body, code())).statusCode, url).toBe(201);
    }
    // Accounts without two-step verification are unchanged.
    expect((await req('POST', '/v1/provider/enrollment-tokens', member.json().token, {})).statusCode).toBe(201);
  });

  it(`locks codes for a while after ${MAX_FAILURES} wrong ones`, async () => {
    const code = await enroll(h.adminToken);
    for (let i = 0; i < MAX_FAILURES; i++)
      expect((await req('POST', '/v1/me/tokens', h.adminToken, { name: 'x' }, '123456')).json().error.code).toBe('MFA_INVALID');
    const locked = await req('POST', '/v1/me/tokens', h.adminToken, { name: 'x' }, code());
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('MFA_LOCKED');
    const failures = await h.rt.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'mfa.failure'`);
    expect(failures.rows[0].n).toBe(MAX_FAILURES);
  });

  it('REQUIRE_STAFF_MFA: staff can only turn it on until they do; public accounts are not affected', async () => {
    h.rt.config.REQUIRE_STAFF_MFA = true;
    const blocked = await req('GET', '/v1/dashboard/overview', h.adminToken);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await req('GET', '/v1/me', h.adminToken)).json().mfa).toEqual({ enabled: false, mustEnroll: true });
    expect((await req('GET', '/v1/me/tokens', h.adminToken)).statusCode).toBe(200);
    await enroll(h.adminToken);
    expect((await req('GET', '/v1/dashboard/overview', h.adminToken)).statusCode).toBe(200);

    const member = (await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'm@ex.test' } })).json();
    expect((await req('GET', '/v1/credits/wallet', member.token)).statusCode).toBe(200);
  });

  it('REQUIRE_STAFF_MFA also closes the live event stream to staff without it', async () => {
    h.rt.config.REQUIRE_STAFF_MFA = true;
    const ws = await h.app.injectWS('/v1/ws', { headers: auth(h.adminToken) });
    expect(await new Promise<number>((r) => ws.on('close', (code) => r(code)))).toBe(WS_CLOSE.REVOKED);
    await enroll(h.adminToken);
    const ok = await h.app.injectWS('/v1/ws', { headers: auth(h.adminToken) });
    const ready = await new Promise<{ type: string }>((r) => ok.on('message', (m) => r(JSON.parse(m.toString()))));
    expect(ready.type).toBe('ready');
    ok.terminate();
  });

  it('turning it off needs a current code; the secret is stored encrypted', async () => {
    const begin = (await req('POST', '/v1/me/mfa/totp', h.adminToken)).json();
    const code = authenticator(begin.secret);
    await req('POST', '/v1/me/mfa/totp/confirm', h.adminToken, { code: code() });
    const stored = (await h.rt.db.query(`SELECT totp_secret FROM users WHERE email = 'a@ghost.test'`)).rows[0].totp_secret as Buffer;
    expect(stored.includes(base32Decode(begin.secret))).toBe(false);
    expect(stored.toString('latin1')).not.toContain(begin.secret);

    expect((await req('DELETE', '/v1/me/mfa/totp', h.adminToken)).json().error.code).toBe('MFA_REQUIRED');
    expect((await req('DELETE', '/v1/me/mfa/totp', h.adminToken, undefined, code())).json()).toMatchObject({ enabled: false });
    expect((await req('POST', '/v1/me/tokens', h.adminToken, { name: 'x' })).statusCode).toBe(201);
    const actions = (await h.rt.db.query(`SELECT action FROM audit_log WHERE action LIKE 'mfa.%' ORDER BY id`)).rows.map((r) => r.action);
    expect(actions).toEqual(['mfa.enable', 'mfa.disable']);
  });

  it('reset-mfa CLI (lost phone) turns it off from the server', async () => {
    await enroll(h.adminToken);
    const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/reset-mfa.ts', 'a@ghost.test'], {
      env: process.env,
      encoding: 'utf8',
    });
    expect(out).toMatch(/two-step verification is off for a@ghost\.test/);
    expect((await req('GET', '/v1/me/mfa', h.adminToken)).json()).toEqual({ enabled: false, enabledAt: null });
    const audit = await h.rt.db.query(`SELECT actor_type FROM audit_log WHERE action = 'mfa.reset'`);
    expect(audit.rows).toEqual([{ actor_type: 'system' }]);
  }, 60_000);
});
