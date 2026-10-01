// Two-step verification with time-based one-time passwords (TOTP, RFC 6238): HMAC-SHA1,
// 6 digits, 30-second steps — what every authenticator app (Google, Microsoft, Authy…)
// reads from an otpauth:// link or QR code. Pure, except for the random secret.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Codes from one step before or after are accepted too (clock drift, typing time). */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20; // RFC 4226: 160 bits for HMAC-SHA1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => randomBytes(SECRET_BYTES);

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return bin.toString().padStart(TOTP_DIGITS, '0');
}

export const stepAt = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/**
 * The step a code belongs to, if it is valid now (± TOTP_WINDOW steps); null otherwise.
 * The caller must refuse steps at or before the last one accepted (a code works once).
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let found: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    // Compare every candidate in constant time; keep going so timing does not tell which matched.
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code)) && found === null) found = s;
  }
  return found;
}

/** What authenticator apps import (also shown as a QR code). */
export function otpauthUrl(secret: Buffer, account: string, issuer = 'ghost'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q}`;
}

// ---- secret at rest ---------------------------------------------------------------
// Stored encrypted (AES-256-GCM) with a key derived from the server's master secret, so a
// database copy alone does not yield anyone's second factor.

export const totpKey = (masterSecret: string) =>
  Buffer.from(hkdfSync('sha256', masterSecret, 'ghost', 'totp-secret-v1', 32));

export function sealSecret(secret: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(secret), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function openSecret(sealed: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}
