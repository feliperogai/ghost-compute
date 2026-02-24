// Deterministic test data for network calibration: SHA-256 in counter mode over a nonce.
// Byte i of the stream is byte (i mod 32) of sha256(nonce || u64le(floor(i / 32))).
// The agent implements the same function (agent/src/calibration/stream.rs); both test
// suites check the same vectors.
import { createHash } from 'node:crypto';

export function streamBytes(nonce: string, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  const ctr = Buffer.alloc(8);
  for (let off = 0, i = 0n; off < length; off += 32, i++) {
    ctr.writeBigUInt64LE(i);
    const block = createHash('sha256').update(nonce).update(ctr).digest();
    block.copy(out, off, 0, Math.min(32, length - off));
  }
  return out;
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** sha256 of a stream, remembered: download, upload check and report verification share it. */
const shaMemo = new Map<string, string>();
export function streamSha256(nonce: string, length: number): string {
  const key = `${nonce}:${length}`;
  let v = shaMemo.get(key);
  if (!v) {
    v = sha256Hex(streamBytes(nonce, length));
    if (shaMemo.size >= 1000) shaMemo.delete(shaMemo.keys().next().value!);
    shaMemo.set(key, v);
  }
  return v;
}
