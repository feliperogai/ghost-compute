// Network of a worker, as seen by the server, for replica diversity: two replicas from
// the same /24 (IPv4) or /48 (IPv6) are likely the same people. Loopback means "same host
// as the server" (development): no network information.
import { isIP } from 'node:net';

export function networkPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    if (v4.startsWith('127.')) return null;
    return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  }
  if (isIP(ip) === 6) {
    if (ip === '::1') return null;
    // Expand "::" to full groups before taking the first three.
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const full = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return `${full.slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return null;
}
