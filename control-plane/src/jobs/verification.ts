// Result verification by replication. Pure: decides whether two results of the same job
// agree, and which result (if any) a set of replicas supports.
//
// Workloads are deterministic, but not bit-for-bit across devices: a GPU and a CPU can
// differ in the last bits of a float. So each type compares what must be identical
// (checksums, labels, error codes) and allows a small tolerance where floats show
// (confidence), never on anything that decides the answer.
import { CLASSES } from '../inference/schemas.js';

/** Confidence may differ by at most this many basis points (0.5%) between replicas. */
export const CONFIDENCE_TOLERANCE_BP = 50;
/** Replicas from distinct owners that must agree. */
export const AGREEMENT = 2;
/** Most replicas a job may run before giving up with RESULT_MISMATCH. */
export const MAX_REPLICAS = 3;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);

function benchmarkAgree(a: Obj, b: Obj): boolean {
  // Timing fields (elapsedMs, opsPerSecond) differ by nature; the work and its checksum may not.
  for (const k of ['kind', 'size', 'iterations', 'seed', 'checksum']) if (a[k] !== b[k]) return false;
  return typeof a.checksum === 'string' && a.checksum.length > 0;
}

interface Item {
  index?: unknown;
  label?: unknown;
  confidenceBp?: unknown;
  error?: unknown;
  topK?: unknown;
}

function inferenceAgree(a: Obj, b: Obj): boolean {
  const ia = Array.isArray(a.items) ? (a.items as Item[]) : null;
  const ib = Array.isArray(b.items) ? (b.items as Item[]) : null;
  if (!ia || !ib || ia.length !== ib.length || ia.length === 0) return false;
  const byIndex = new Map(ib.map((x) => [x.index, x]));
  if (byIndex.size !== ib.length) return false;
  for (const x of ia) {
    const y = byIndex.get(x.index);
    if (!y) return false;
    if ((x.error ?? null) !== (y.error ?? null)) return false;
    if (x.error != null) continue;
    if (x.label !== y.label || typeof x.label !== 'number' || x.label < 0 || x.label >= CLASSES) return false;
    if (typeof x.confidenceBp !== 'number' || typeof y.confidenceBp !== 'number') return false;
    if (Math.abs(x.confidenceBp - y.confidenceBp) > CONFIDENCE_TOLERANCE_BP) return false;
  }
  return true;
}

/** Whether two outputs of the same job are the same answer. Unknown types never agree. */
export function resultsAgree(type: string, a: unknown, b: unknown): boolean {
  const oa = obj(a);
  const ob = obj(b);
  if (!oa || !ob) return false;
  if (type === 'benchmark') return benchmarkAgree(oa, ob);
  if (type === 'image-inference') return inferenceAgree(oa, ob);
  return false;
}

export interface Replica {
  assignmentId: string;
  ownerId: string | null;
  output: unknown;
  /** Staff-owned computer: its answer decides. */
  trusted?: boolean;
}

export type Verdict =
  /** `winner` is the replica whose output becomes the job's; `agreed` get paid. */
  | { kind: 'agreed'; winner: string; agreed: string[]; disagreed: string[] }
  | { kind: 'pending' }
  | { kind: 'mismatch'; disagreed: string[] };

/**
 * Looks for AGREEMENT replicas, from distinct owners, with the same answer. The earliest
 * replica of the largest agreeing group wins (deterministic given the order).
 */
export function verdict(type: string, replicas: Replica[], requireTrusted = false): Verdict {
  // A trusted replica decides: whoever agrees with it is right, everyone else is not.
  const judge = replicas.find((r) => r.trusted);
  if (judge) {
    const agreed = replicas.filter((r) => r === judge || resultsAgree(type, judge.output, r.output)).map((r) => r.assignmentId);
    const set = new Set(agreed);
    return { kind: 'agreed', winner: judge.assignmentId, agreed, disagreed: replicas.filter((r) => !set.has(r.assignmentId)).map((r) => r.assignmentId) };
  }
  if (requireTrusted) return { kind: 'pending' };
  let best: Replica[] = [];
  for (const r of replicas) {
    const group = replicas.filter((o) => o === r || resultsAgree(type, r.output, o.output));
    const owners = new Set(group.map((g) => g.ownerId ?? g.assignmentId));
    if (owners.size >= AGREEMENT && group.length > best.length) best = group;
  }
  if (best.length) {
    const agreed = new Set(best.map((g) => g.assignmentId));
    return {
      kind: 'agreed',
      winner: best[0]!.assignmentId,
      agreed: [...agreed],
      disagreed: replicas.filter((r) => !agreed.has(r.assignmentId)).map((r) => r.assignmentId),
    };
  }
  if (replicas.length >= MAX_REPLICAS) return { kind: 'mismatch', disagreed: replicas.map((r) => r.assignmentId) };
  return { kind: 'pending' };
}
