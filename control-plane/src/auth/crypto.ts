import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type SecretKind = 'user' | 'enroll' | 'worker';
const PREFIX: Record<SecretKind, string> = { user: 'ghu_', enroll: 'ghe_', worker: 'ghw_' };

/** High-entropy secret (256 bit). Only its hash is stored. */
export function generateSecret(kind: SecretKind): string {
  return PREFIX[kind] + randomBytes(32).toString('base64url');
}

export function hasPrefix(secret: string, kind: SecretKind): boolean {
  return secret.startsWith(PREFIX[kind]);
}

/** SHA-256 is enough: secrets are random 256-bit values, not passwords. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface WorkerClaims {
  sub: string;
  typ: 'worker';
  iat: number;
  exp: number;
}

/** Compact HMAC-SHA256 session token: v1.<payload>.<sig>. */
export function signWorkerToken(workerId: string, secret: string, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const claims: WorkerClaims = { sub: workerId, typ: 'worker', iat, exp: iat + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${sig}`;
}

export function verifyWorkerToken(token: string, secret: string, now = Date.now()): WorkerClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`v1.${payload}`).digest();
  if (!safeEqual(Buffer.from(sig, 'base64url'), expected)) return null;
  let claims: WorkerClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.typ !== 'worker' || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp <= Math.floor(now / 1000)) return null;
  return claims;
}
