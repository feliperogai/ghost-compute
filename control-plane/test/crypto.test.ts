import { describe, expect, it } from 'vitest';
import {
  generateSecret,
  hashSecret,
  hasPrefix,
  safeEqual,
  signWorkerToken,
  verifyWorkerToken,
} from '../src/auth/crypto.js';

const KEY = 'k'.repeat(32);

describe('secrets', () => {
  it('generates unique prefixed secrets', () => {
    const a = generateSecret('worker');
    expect(hasPrefix(a, 'worker')).toBe(true);
    expect(hasPrefix(a, 'user')).toBe(false);
    expect(a).not.toBe(generateSecret('worker'));
  });

  it('hashes deterministically', () => {
    const s = generateSecret('user');
    expect(safeEqual(hashSecret(s), hashSecret(s))).toBe(true);
    expect(safeEqual(hashSecret(s), hashSecret(s + 'x'))).toBe(false);
  });
});

describe('worker token', () => {
  it('round-trips', () => {
    const t = signWorkerToken('w1', KEY, 60);
    expect(verifyWorkerToken(t, KEY)?.sub).toBe('w1');
  });

  it('rejects wrong key, tampering and expiry', () => {
    const t = signWorkerToken('w1', KEY, 60);
    expect(verifyWorkerToken(t, 'x'.repeat(32))).toBeNull();
    const [v, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'w2', typ: 'worker', iat: 0, exp: 9e9 })).toString(
      'base64url',
    );
    expect(verifyWorkerToken(`${v}.${forged}.${s}`, KEY)).toBeNull();
    expect(verifyWorkerToken(`${v}.${p}`, KEY)).toBeNull();
    expect(verifyWorkerToken(t, KEY, Date.now() + 61_000)).toBeNull();
  });
});
