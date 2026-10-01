// The engine runs against in-memory ports: no Postgres, no Redis.
import { describe, expect, it } from 'vitest';
import {
  SchedulerEngine,
  createStrategy,
  registerStrategy,
  weightedStrategy,
  zeroResources,
  type JobSpec,
  type Placement,
  type PlacementStrategy,
  type SchedulerMonitors,
  type SchedulerStore,
  type WorkerSnapshot,
} from '../src/scheduler/index.js';

const now = new Date('2026-01-01T12:00:00Z');

class MemoryStore implements SchedulerStore, SchedulerMonitors {
  assigned: { jobId: string; workerId: string; strategy: string }[] = [];
  pending = new Map<string, string | null>();
  monitorCalls: string[] = [];
  constructor(
    public jobs: JobSpec[],
    public ws: WorkerSnapshot[],
  ) {}
  async queuedJobs(limit: number) {
    const taken = new Set(this.assigned.map((a) => a.jobId));
    return this.jobs.filter((j) => !taken.has(j.id)).slice(0, limit);
  }
  async workers() {
    return this.ws;
  }
  async assign(p: Placement, strategy: string) {
    this.assigned.push({ jobId: p.jobId, workerId: p.workerId, strategy });
    return true;
  }
  async setPendingReason(jobId: string, reason: string | null) {
    this.pending.set(jobId, reason);
  }
  detectOfflineWorkers = async () => (this.monitorCalls.push('offline'), 0);
  expireUnaccepted = async () => (this.monitorCalls.push('expire'), 0);
  reclaimStale = async () => (this.monitorCalls.push('stale'), 0);
  enforceTimeouts = async () => (this.monitorCalls.push('timeout'), 0);
  reconcile = async () => (this.monitorCalls.push('reconcile'), 0);
}

const worker = (id: string, cores = 4): WorkerSnapshot => ({
  id,
  state: 'available',
  lastSeenAt: new Date(now.getTime() - 500),
  maxConcurrent: 4,
  workloadTypes: ['benchmark'],
  hardware: { os: { name: 'Windows' }, cpu: { cores: 8 }, ramMb: 16384, gpus: [] },
  capacity: { cpuCores: cores, ramMb: 8192, gpuPercent: 0, vramMb: 0, diskMb: 1000, maxTemperatureC: 85 },
  usage: { cpuPercent: 5, temperatureC: 50 },
  reserved: zeroResources(),
  activeAssignments: 0,
  recent: { completed: 0, failed: 0 },
});

const job = (id: string, cores = 1): JobSpec => ({
  id,
  type: 'benchmark',
  priority: 50,
  requirements: {},
  resources: { cpuCores: cores, ramMb: 256, gpu: false, vramMb: 0, diskMb: 0 },
  createdAt: now,
  excludedWorkers: [],
});

const opts = { batchSize: 100, offlineAfterMs: 20_000, thermalMarginC: 3, reconcileEveryTicks: 10, now: () => now };

describe('SchedulerEngine', () => {
  it('runs monitors, then places and explains what it could not place', async () => {
    const store = new MemoryStore([job('a'), job('big', 64)], [worker('w1')]);
    const engine = new SchedulerEngine(store, store, weightedStrategy(), opts);
    const r = await engine.tick();
    expect(store.monitorCalls).toEqual(['reconcile', 'offline', 'timeout', 'expire', 'stale']);
    expect(r).toMatchObject({ considered: 2, assigned: 1, unplaced: 1 });
    expect(store.assigned).toEqual([{ jobId: 'a', workerId: 'w1', strategy: 'weighted' }]);
    expect(store.pending.get('big')).toBe('no eligible worker (1× INSUFFICIENT_CPU)');
  });

  it('accepts any strategy through the registry', async () => {
    // Trivial alternative: first compatible worker, alphabetical.
    registerStrategy('first-fit', () => ({
      name: 'first-fit',
      place: (jobs, workers) => ({
        placements: jobs.map((j) => ({ jobId: j.id, workerId: [...workers].sort((x, y) => x.id.localeCompare(y.id))[0]!.id, score: { total: 1, components: {} } })),
        unplaced: [],
      }),
    }));
    const store = new MemoryStore([job('a')], [worker('z'), worker('b')]);
    await new SchedulerEngine(store, store, createStrategy('first-fit'), opts).tick();
    expect(store.assigned[0]).toEqual({ jobId: 'a', workerId: 'b', strategy: 'first-fit' });
    expect(() => createStrategy('nope')).toThrow(/unknown scheduling strategy/);
  });

  it('refuses placements from a faulty strategy that would over-commit', async () => {
    const greedy: PlacementStrategy = {
      name: 'broken',
      // Puts everything on one worker regardless of capacity.
      place: (jobs) => ({ placements: jobs.map((j) => ({ jobId: j.id, workerId: 'w1', score: { total: 1, components: {} } })), unplaced: [] }),
    };
    const store = new MemoryStore([job('1', 2), job('2', 2), job('3', 2)], [worker('w1', 4)]);
    const warnings: object[] = [];
    const engine = new SchedulerEngine(store, store, greedy, opts, { info() {}, warn: (o) => warnings.push(o) });
    const r = await engine.tick();
    expect(r.assigned).toBe(2);
    expect(r.rejectedPlacements).toBe(1);
    expect(store.assigned.map((a) => a.jobId)).toEqual(['1', '2']);
    expect(warnings[0]).toMatchObject({ why: 'INSUFFICIENT_CPU', strategy: 'broken' });
  });

  it('spot checks wait for a trusted computer only while one is online to take them', async () => {
    const spot = { ...job('s'), trustedCheck: true };
    const run = async (ws: WorkerSnapshot[]) => {
      const store = new MemoryStore([spot], ws);
      await new SchedulerEngine(store, store, weightedStrategy(), opts).tick();
      return store;
    };
    const trusted = { ...worker('t'), trusted: true };
    // Online: only the trusted computer may verify.
    expect((await run([worker('u'), trusted])).assigned.map((a) => a.workerId)).toEqual(['t']);
    // Online but busy: the job waits for it.
    const busy = await run([worker('u'), { ...trusted, activeAssignments: 4 }]);
    expect(busy.assigned).toEqual([]);
    expect(busy.pending.get('s')).toContain('UNTRUSTED_VERIFIER');
    // None online (offline, not taking work, off the market): verified as usual, no wait.
    const unlisted = { ...trusted, offer: { listed: false, price: { cpuCore: 1, ramGb: 1, gpu: 1, vramGb: 1 }, availability: { timezone: 'UTC', windows: [] }, limits: {} } };
    for (const away of [{ ...trusted, lastSeenAt: new Date(now.getTime() - 60_000) }, { ...trusted, state: 'waiting' as const }, unlisted])
      expect((await run([worker('u'), away])).assigned.map((a) => a.workerId)).toEqual(['u']);
    // Not spot-checked: never waits for the trusted computer.
    const store = new MemoryStore([job('n')], [worker('u'), { ...trusted, activeAssignments: 4 }]);
    await new SchedulerEngine(store, store, weightedStrategy(), opts).tick();
    expect(store.assigned.map((a) => a.workerId)).toEqual(['u']);
  });

  it('does nothing when the queue is empty', async () => {
    const store = new MemoryStore([], [worker('w1')]);
    expect(await new SchedulerEngine(store, store, weightedStrategy(), opts).tick()).toMatchObject({ considered: 0, assigned: 0 });
  });
});
