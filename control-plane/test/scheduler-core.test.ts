import { describe, expect, it } from 'vitest';
import { describeUnplaced, ineligibility } from '../src/scheduler/eligibility.js';
import { score, weightedStrategy } from '../src/scheduler/strategies/weighted.js';
import { defaultRetryPolicy } from '../src/scheduler/retry.js';
import { zeroResources, type JobSpec, type WorkerSnapshot } from '../src/scheduler/types.js';

const now = new Date('2026-01-01T12:00:00Z');
const opts = { now, offlineAfterMs: 20_000, thermalMarginC: 3 };

function worker(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id,
    state: 'available',
    lastSeenAt: new Date(now.getTime() - 1000),
    maxConcurrent: 2,
    workloadTypes: ['benchmark'],
    hardware: { os: { name: 'Windows' }, cpu: { cores: 8, threads: 16, features: ['avx2'] }, ramMb: 32768, gpus: [] },
    capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: 0, vramMb: 0, diskMb: 10_000, maxTemperatureC: 85 },
    usage: { cpuPercent: 10, cpuGhostPercent: 0, temperatureC: 50 },
    reserved: zeroResources(),
    activeAssignments: 0,
    recent: { completed: 0, failed: 0 },
    ...over,
  };
}

function job(id: string, over: Partial<JobSpec> = {}): JobSpec {
  return {
    id,
    type: 'benchmark',
    priority: 50,
    requirements: {},
    resources: { cpuCores: 1, ramMb: 1024, gpu: false, vramMb: 0, diskMb: 0 },
    createdAt: now,
    excludedWorkers: [],
    ...over,
  };
}

const gpuWorker = (id: string, over: Partial<WorkerSnapshot> = {}) =>
  worker(id, {
    workloadTypes: ['benchmark', 'gpu-test'],
    hardware: { os: { name: 'Windows' }, cpu: { cores: 8, features: [] }, ramMb: 32768, gpus: [{ name: 'RTX', vendor: 'NVIDIA', vramMb: 12288 }] },
    capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: 50, vramMb: 12288, diskMb: 10_000, maxTemperatureC: 85 },
    ...over,
  });

describe('eligibility (hard constraints)', () => {
  it.each<[string, Partial<WorkerSnapshot>, Partial<JobSpec>]>([
    ['OFFLINE', { lastSeenAt: new Date(now.getTime() - 60_000) }, {}],
    ['NOT_ACCEPTING', { state: 'paused' }, {}],
    ['EXCLUDED', {}, { excludedWorkers: ['w'] }],
    ['NO_CAPACITY_REPORTED', { capacity: null }, {}],
    ['TYPE_UNSUPPORTED', { workloadTypes: [] }, {}],
    ['NO_SLOTS', { activeAssignments: 2 }, {}],
    ['OS_MISMATCH', {}, { requirements: { os: 'linux' } }],
    ['CPU_FEATURES', {}, { requirements: { cpuFeatures: ['avx512f'] } }],
    ['INSUFFICIENT_CPU', {}, { resources: { cpuCores: 5, ramMb: 1, gpu: false, vramMb: 0, diskMb: 0 } }],
    ['INSUFFICIENT_RAM', {}, { resources: { cpuCores: 1, ramMb: 9000, gpu: false, vramMb: 0, diskMb: 0 } }],
    ['INSUFFICIENT_DISK', {}, { resources: { cpuCores: 1, ramMb: 1, gpu: false, vramMb: 0, diskMb: 20_000 } }],
    ['NO_GPU', {}, { resources: { cpuCores: 1, ramMb: 1, gpu: true, vramMb: 0, diskMb: 0 } }],
    ['TOO_HOT', { usage: { temperatureC: 83 } }, {}],
  ])('%s', (reason, w, j) => {
    expect(ineligibility(job('j', j), worker('w', w), opts)).toBe(reason);
  });

  it('accounts for resources already reserved', () => {
    const busy = worker('w', { reserved: { cpuCores: 3.5, ramMb: 0, gpu: false, vramMb: 0, diskMb: 0 }, activeAssignments: 1 });
    expect(ineligibility(job('j'), busy, opts)).toBe('INSUFFICIENT_CPU');
  });

  it('gpu requirements', () => {
    const g = gpuWorker('g');
    const gj = job('j', { type: 'gpu-test', resources: { cpuCores: 1, ramMb: 512, gpu: true, vramMb: 4096, diskMb: 0 } });
    expect(ineligibility(gj, g, opts)).toBeNull();
    expect(ineligibility({ ...gj, requirements: { gpuVendor: 'AMD' } }, g, opts)).toBe('GPU_VENDOR');
    expect(ineligibility({ ...gj, requirements: { minVramMb: 16000 } }, g, opts)).toBe('INSUFFICIENT_VRAM');
    expect(ineligibility(gj, { ...g, reserved: { ...zeroResources(), gpu: true } }, opts)).toBe('NO_GPU');
    // Owner shares no GPU.
    expect(ineligibility(gj, { ...g, capacity: { ...g.capacity!, gpuPercent: 0 } }, opts)).toBe('NO_GPU');
  });
});

describe('weighted strategy', () => {
  const s = weightedStrategy();

  it('prefers headroom, cool, idle, reliable workers', () => {
    const cool = worker('a', { usage: { cpuPercent: 5, temperatureC: 45 }, recent: { completed: 20, failed: 0 } });
    const hot = worker('b', { usage: { cpuPercent: 5, temperatureC: 78 } });
    const busyOwner = worker('c', { usage: { cpuPercent: 70, temperatureC: 45 } });
    const flaky = worker('d', { usage: { cpuPercent: 5, temperatureC: 45 }, recent: { completed: 1, failed: 9 } });
    const r = s.place([job('j')], [hot, busyOwner, flaky, cool], opts);
    expect(r.placements[0]?.workerId).toBe('a');
    const sa = score(job('j'), cool, opts);
    const sb = score(job('j'), hot, opts);
    expect(sa.total).toBeGreaterThan(sb.total);
    expect(sa.components.thermal).toBeGreaterThan(sb.components.thermal!);
  });

  it('keeps GPU workers free for GPU jobs', () => {
    const r = s.place([job('cpu-job')], [gpuWorker('g'), worker('c')], opts);
    expect(r.placements[0]?.workerId).toBe('c');
    const g = s.place([job('gpu-job', { type: 'gpu-test', resources: { cpuCores: 1, ramMb: 512, gpu: true, vramMb: 2048, diskMb: 0 } })], [gpuWorker('g'), worker('c')], opts);
    expect(g.placements[0]?.workerId).toBe('g');
  });

  it('reserves within a batch and reports why the rest cannot be placed', () => {
    const w = worker('w', { maxConcurrent: 10 }); // 4 cores offered
    const jobs = ['1', '2', '3', '4', '5'].map((id) => job(id, { resources: { cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 } }));
    const r = s.place(jobs, [w], opts);
    expect(r.placements.map((p) => p.jobId)).toEqual(['1', '2', '3', '4']);
    expect(r.unplaced).toEqual([{ jobId: '5', reasons: { INSUFFICIENT_CPU: 1 } }]);
    expect(describeUnplaced({ INSUFFICIENT_CPU: 1, TOO_HOT: 3 }, 4)).toBe('no eligible worker (3× TOO_HOT, 1× INSUFFICIENT_CPU)');
    expect(describeUnplaced({}, 0)).toBe('no workers registered');
  });

  it('spreads load across equal workers and is deterministic', () => {
    const ws = [worker('b'), worker('a')];
    const jobs = [job('1'), job('2')];
    const r1 = s.place(jobs, ws, opts);
    expect(r1.placements.map((p) => p.workerId)).toEqual(['a', 'b']);
    expect(s.place(jobs, ws, opts)).toEqual(r1);
  });

  it('scores are normalized with an explainable breakdown', () => {
    const b = score(job('j'), worker('w'), opts);
    expect(b.total).toBeGreaterThan(0);
    expect(b.total).toBeLessThanOrEqual(1);
    expect(Object.keys(b.components).sort()).toEqual(['availability', 'cpu', 'gpu', 'load', 'ram', 'reliability', 'thermal']);
  });
});

describe('retry policy', () => {
  const p = defaultRetryPolicy;
  it('requeues environmental failures up to maxAttempts', () => {
    expect(p.decide({ kind: 'rejected' }, 99, 3)).toBe('REQUEUE');
    expect(p.decide({ kind: 'lost' }, 1, 3)).toBe('REQUEUE');
    expect(p.decide({ kind: 'expired' }, 3, 3)).toBe('FAIL');
    expect(p.decide({ kind: 'failed', retryable: true }, 2, 3)).toBe('REQUEUE');
    expect(p.decide({ kind: 'failed', retryable: false }, 1, 3)).toBe('FAIL');
  });
});
