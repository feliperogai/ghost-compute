// The replaceable part. A strategy decides WHERE jobs go; the engine decides
// WHEN, persists the decision and re-checks every placement against the hard
// constraints, so a faulty strategy cannot over-commit a worker.
import type { EligibilityOptions } from './eligibility.js';
import type { JobSpec, PlacementResult, WorkerSnapshot } from './types.js';

export interface PlacementStrategy {
  readonly name: string;
  /**
   * Place a batch of queued jobs (already ordered by priority, then age) onto workers.
   * Must be pure and deterministic for the same input.
   */
  place(jobs: JobSpec[], workers: WorkerSnapshot[], opts: EligibilityOptions): PlacementResult;
}

const registry = new Map<string, () => PlacementStrategy>();

export function registerStrategy(name: string, factory: () => PlacementStrategy) {
  registry.set(name, factory);
}

export function createStrategy(name: string): PlacementStrategy {
  const f = registry.get(name);
  if (!f) throw new Error(`unknown scheduling strategy '${name}' (known: ${[...registry.keys()].join(', ')})`);
  return f();
}
