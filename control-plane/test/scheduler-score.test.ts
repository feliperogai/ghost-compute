// The scoring strategy: formula, each factor's effect, priority, determinism, explanation.
import { describe, expect, it } from 'vitest';
import { explain, scoreStrategy, scoreWorker, TERMS, WEIGHTS_BY_PRIORITY } from '../src/scheduler/strategies/score.js';
import { zeroResources, type JobSpec, type PerformanceView, type WorkerSnapshot } from '../src/scheduler/types.js';

const now = new Date('2026-01-01T12:00:00Z');
const opts = { now, offlineAfterMs: 20_000, thermalMarginC: 3 };
const s = scoreStrategy();

const perf = (over: Partial<PerformanceView> = {}): PerformanceView => ({
  cpuScore: 1000,
  inference: { cpuItemsPerSec: 400, gpuItemsPerSec: null, cpuStartupMs: 500 },
  gpu: null,
  network: { latencyMs: 20, downloadMbps: 200 },
  observed: {},
  ...over,
});

function worker(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id,
    name: `pc-${id}`,
    onlineSince: new Date(now.getTime() - 2 * 3600_000),
    state: 'available',
    lastSeenAt: new Date(now.getTime() - 1000),
    maxConcurrent: 4,
    workloadTypes: ['benchmark', 'image-inference'],
    hardware: { os: { name: 'Windows' }, cpu: { cores: 8, threads: 16 }, ramMb: 32768, gpus: [] },
    capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: 0, vramMb: 0, diskMb: 10_000, maxTemperatureC: 85 },
    usage: { cpuPercent: 5, cpuGhostPercent: 0, temperatureC: 50 },
    reserved: zeroResources(),
    activeAssignments: 0,
    recent: { completed: 10, failed: 0 },
    performance: perf(),
    ...over,
  };
}

const job = (over: Partial<JobSpec> = {}): JobSpec => ({
  id: 'j',
  type: 'image-inference',
  priority: 50,
  requirements: {},
  resources: { cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 },
  createdAt: now,
  excludedWorkers: [],
  timeoutSeconds: 600,
  work: { items: 128, bytes: 128 * 20_000, accelerator: 'cpu' },
  ...over,
});
const pick = (j: JobSpec, ws: WorkerSnapshot[]) => s.place([j], ws, opts).placements[0]!;

describe('worker_score formula', () => {
  it('= performance + availability + reliability + resource_fit − latency − current_load', () => {
    const b = scoreWorker(job(), worker('a'), opts);
    const t = b.terms!;
    expect(Object.keys(t)).toEqual([...TERMS]);
    for (const name of TERMS) {
      expect(t[name]!.value).toBeGreaterThanOrEqual(0);
      expect(t[name]!.value).toBeLessThanOrEqual(1);
      const sign = name === 'latency' || name === 'current_load' ? -1 : 1;
      expect(t[name]!.contribution).toBeCloseTo(sign * t[name]!.weight * t[name]!.value, 3);
    }
    const sum = TERMS.reduce((acc, n) => acc + t[n]!.contribution, 0);
    expect(b.total).toBeCloseTo(sum, 2);
  });

  it('weights depend only on the priority band', () => {
    expect(scoreWorker(job({ priority: 90 }), worker('a'), opts).terms!.performance!.weight).toBe(WEIGHTS_BY_PRIORITY.high.performance);
    expect(scoreWorker(job({ priority: 10 }), worker('a'), opts).terms!.resource_fit!.weight).toBe(WEIGHTS_BY_PRIORITY.low.resource_fit);
    for (const w of Object.values(WEIGHTS_BY_PRIORITY)) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe('each factor moves the decision (all else equal)', () => {
  const base = worker('a');
  it.each<[string, Partial<WorkerSnapshot>, Partial<WorkerSnapshot>]>([
    // Compute-bound (fast network), otherwise transfer time dominates and speed does not matter.
    [
      'performance (histórica/medida)',
      { performance: perf({ inference: { cpuItemsPerSec: 2000, gpuItemsPerSec: null, cpuStartupMs: 500 }, network: { latencyMs: 1, downloadMbps: 1000 } }) },
      { performance: perf({ network: { latencyMs: 1, downloadMbps: 1000 } }) },
    ],
    ['performance observada em jobs reais', {}, { performance: perf({ observed: { 'image-inference': { itemsPerSec: 5, samples: 10 } } }) }],
    ['availability: heartbeat recente', { lastSeenAt: new Date(now.getTime() - 500) }, { lastSeenAt: new Date(now.getTime() - 15_000) }],
    ['availability: online há mais tempo', {}, { onlineSince: new Date(now.getTime() - 60_000) }],
    ['reliability: taxa de falha', { recent: { completed: 20, failed: 0 } }, { recent: { completed: 10, failed: 10 } }],
    ['latency', {}, { performance: perf({ network: { latencyMs: 250, downloadMbps: 200 } }) }],
    ['current_load: dono usando a CPU', {}, { usage: { cpuPercent: 70, cpuGhostPercent: 0, temperatureC: 50 } }],
    ['current_load: temperatura', {}, { usage: { cpuPercent: 5, cpuGhostPercent: 0, temperatureC: 79 } }],
    ['current_load: vagas ocupadas', {}, { activeAssignments: 3 }],
    ['resource_fit: não ocupar máquina com GPU', {}, { capacity: { ...base.capacity!, gpuPercent: 50, vramMb: 8192 } }],
  ])('%s', (_name, better, worse) => {
    // Ids chosen so that the better worker does NOT win the id tie-break.
    const good = worker('z', better);
    const bad = worker('a', worse);
    expect(pick(job(), [bad, good]).workerId).toBe('z');
  });

  it('prioridade: urgente vai para a GPU rápida; baixa prioridade fica na CPU barata', () => {
    const gpuBox = worker('g', {
      capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: 80, vramMb: 12288, diskMb: 1000, maxTemperatureC: 85 },
      hardware: { os: { name: 'Windows' }, cpu: { cores: 8 }, ramMb: 32768, gpus: [{ name: 'RTX 4070', vendor: 'NVIDIA', vramMb: 12288 }] },
      performance: perf({
        inference: { cpuItemsPerSec: 400, gpuItemsPerSec: 5000, cpuStartupMs: 500, gpuStartupMs: 900 },
        gpu: { verified: true, vramAvailableMb: 11000, nvidia: true },
        network: { latencyMs: 2, downloadMbps: 1000 },
      }),
    });
    const cpuBox = worker('c', { performance: perf({ inference: { cpuItemsPerSec: 150, gpuItemsPerSec: null, cpuStartupMs: 500 }, network: { latencyMs: 2, downloadMbps: 1000 } }) });
    const work = { items: 256, bytes: 256 * 20_000, accelerator: 'auto' as const };
    expect(pick(job({ priority: 90, work }), [cpuBox, gpuBox]).workerId).toBe('g');
    expect(pick(job({ priority: 10, work }), [cpuBox, gpuBox]).workerId).toBe('c');
  });
});

describe('determinism and explanation', () => {
  const fleet = [
    worker('w1', { usage: { cpuPercent: 40, cpuGhostPercent: 0, temperatureC: 70 } }),
    worker('w2', { performance: perf({ network: { latencyMs: 90, downloadMbps: 50 } }) }),
    worker('w3', { recent: { completed: 3, failed: 5 } }),
    worker('w4'),
    worker('hot', { usage: { cpuPercent: 5, cpuGhostPercent: 0, temperatureC: 84 } }),
    worker('busy', { activeAssignments: 4 }),
  ];
  const jobs = Array.from({ length: 5 }, (_, i) => job({ id: `j${i}`, priority: [90, 50, 10, 50, 70][i]! }));

  it('same input → same placements and same text, whatever the order', () => {
    const a = s.place(jobs, fleet, opts);
    expect(s.place(jobs, [...fleet].reverse(), opts)).toEqual(a);
    expect(s.place(jobs, fleet, opts)).toEqual(a);
  });

  it('says why, compared with the runner-up, and why others were discarded', () => {
    const p = pick(job(), fleet);
    expect(p.workerId).toBe('w4');
    const e = p.explanation!;
    expect(e.summary).toMatch(/^Worker pc-w4 \(w4\) foi escolhido porque /);
    expect(e.summary).toContain('2 worker(s) descartado(s): 1× sem vaga livre, 1× temperatura perto do limite.');
    expect(e.summary).toContain('Prioridade 50 (normal).');
    expect(e.runnerUp!.workerId).not.toBe('w4');
    expect(e.runnerUp!.margin).toBeGreaterThan(0);
    expect(e.reasons.length).toBeGreaterThan(0);
    expect(e.candidates.map((c) => c.workerId)[0]).toBe('w4');
    expect(e.formula).toBe('performance + availability + reliability + resource_fit − latency − current_load');
    // The chosen worker's terms are all there, with the raw inputs behind them.
    expect(e.chosen.terms.latency!.factors.latencyMs).toBe(20);
    expect(e.chosen.terms.reliability!.factors).toEqual({ reputation: null, completed: 10, failed: 0 });
  });

  it('names the deciding factor', () => {
    const slow = worker('a', { performance: perf({ network: { latencyMs: 300, downloadMbps: 200 } }) });
    const fast = worker('b');
    const e = pick(job(), [slow, fast]).explanation!;
    // Latency also slows the per-image downloads, so it shows up in performance too.
    expect(e.reasons.join(' | ')).toContain('menor latência (20 ms vs 300 ms)');
    const lone = explain(job(), fast, [{ w: fast, s: scoreWorker(job(), fast, opts) }], {});
    expect(lone.summary).toContain('era o único worker elegível');
  });
});
