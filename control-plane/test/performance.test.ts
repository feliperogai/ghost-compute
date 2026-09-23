import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, calibrate, heartbeat, makeUser, registerWorker, reset, setup, type Harness } from './helpers.js';
import { syntheticReport, DEFAULT_PARAMS } from './calibration-fixtures.js';
import { createUserWithToken } from '../src/modules/admin/service.js';
import { streamBytes, sha256Hex } from '../src/performance/stream.js';
import { gpuMatmulChecksum } from '../src/performance/suite.js';
import { buildProfile, REFERENCE } from '../src/performance/profile.js';
import { toPerformanceView } from '../src/performance/service.js';
import { estimateSeconds, performanceComponent } from '../src/scheduler/performance.js';
import { ineligibility } from '../src/scheduler/eligibility.js';
import { weightedStrategy } from '../src/scheduler/strategies/weighted.js';
import { zeroResources, type JobSpec, type WorkerSnapshot } from '../src/scheduler/types.js';

const NOW = new Date('2026-01-01T12:00:00Z');
const NONCE = 'fixed-nonce';
const profileOf = (s: Parameters<typeof syntheticReport>[2] = {}) =>
  buildProfile(syntheticReport(DEFAULT_PARAMS, NONCE, s), DEFAULT_PARAMS, NONCE, { upload: { bytes: 8 << 20, elapsedMs: 1342, ok: true } }, { cpu: { model: 'Test CPU' } }, NOW);

describe('reproducible test vectors (shared with the agent)', () => {
  it('network stream', () => {
    expect(streamBytes('ghost-test-vector', 40).toString('hex')).toBe(
      '8cc68a445b6b23d09e5966ebadd30f23bf0983491f267ca81a85ea617f470198e49049142a6d5989',
    );
    expect(sha256Hex(streamBytes('ghost-test-vector', 100_000))).toBe('b9ac005dd52e78d2e9f37aec4768d388c0538943faef2d95a5fc60fd3d3cf01d');
  });

  it('GPU matmul checksum', () => {
    expect(gpuMatmulChecksum(64)).toBe('-920');
    expect(gpuMatmulChecksum(128)).toBe('5167');
    expect(gpuMatmulChecksum(512)).toBe('213');
  });
});

describe('WorkerPerformanceProfile', () => {
  it('is deterministic and scores the reference machine at 1000', () => {
    const a = profileOf();
    expect(profileOf()).toEqual(a);
    expect(a.verified).toBe(true);
    expect(a.issues).toEqual([]);
    expect(a.scores.cpu).toBeGreaterThanOrEqual(995);
    expect(a.scores.cpu).toBeLessThanOrEqual(1005);
    expect(a.scores.inference).toBeGreaterThanOrEqual(995);
    expect(a.scores.inference).toBeLessThanOrEqual(1005);
    expect(a.cpu).toMatchObject({ model: 'Test CPU', threads: 16, offeredCores: 8, parallel: { sandboxes: 4, speedup: 3.2 } });
    expect(a.network).toMatchObject({ latencyMs: { min: 20, median: 21 }, downloadMbps: 100, uploadMbps: 50 });
    expect(a.gpu).toBeNull();
    expect(a.inference).toMatchObject({ best: 'cpu', itemsPerSec: 500, avgLatencyMs: 2 });
    expect(a.storage).toMatchObject({ seqWriteMBps: 167.8, seqReadMBps: 671.1, syncLatencyMs: 2 });
  });

  it('describes a GPU worker like an RTX 4070', () => {
    const p = profileOf({ gpuGflops: 20_000, inferGpu: 8000, vramTotalMb: 12_282, vramUsedMb: 1282 });
    expect(p.gpu).toMatchObject({ name: 'NVIDIA GeForce RTX 4070', nvidia: true, vramTotalMb: 12_282, vramAvailableMb: 11_000, verified: true });
    expect(p.gpu!.matmulGflops).toBeCloseTo(20_000, -2);
    expect(p.scores.gpu).toBeGreaterThan(19_000);
    expect(p.inference.best).toBe('gpu');
    expect(p.inference.itemsPerSec).toBeCloseTo(8000, -2);
  });

  it('flags every check that does not match', () => {
    expect(profileOf({ wrongCpuChecksum: true })).toMatchObject({ verified: false });
    expect(profileOf({ wrongCpuChecksum: true }).issues).toContain('CPU_CHECKSUM:hash');

    const badGpu = profileOf({ gpuGflops: 20_000, inferGpu: 8000, wrongGpuChecksum: true });
    expect(badGpu.verified).toBe(true); // the CPU side is still fine
    expect(badGpu.gpu).toMatchObject({ verified: false, score: 0 });
    expect(badGpu.inference.gpu).toBeNull();
    expect(badGpu.issues).toContain('GPU_CHECKSUM');

    const badLabels = profileOf({ gpuGflops: 20_000, inferGpu: 8000, wrongLabels: 30 });
    expect(badLabels.issues).toContain('INFERENCE_GPU_MISMATCH');
    expect(badLabels.gpu!.verified).toBe(false);
    // A few rounding differences on the GPU are tolerated.
    expect(profileOf({ gpuGflops: 20_000, inferGpu: 8000, wrongLabels: 2 }).gpu!.verified).toBe(true);

    const dl = profileOf({ wrongDownload: true });
    expect(dl.issues).toContain('DOWNLOAD_MISMATCH');
    expect(dl.network.downloadMbps).toBeNull();
  });
});

// ---- scheduler ---------------------------------------------------------------------------

const opts = { now: NOW, offlineAfterMs: 20_000, thermalMarginC: 3 };
function snapshot(id: string, speeds: Parameters<typeof syntheticReport>[2] | null, gpu = false): WorkerSnapshot {
  const p = speeds ? profileOf(speeds) : null;
  return {
    id,
    state: 'available',
    lastSeenAt: new Date(NOW.getTime() - 1000),
    maxConcurrent: 4,
    workloadTypes: ['benchmark', 'image-inference'],
    hardware: { os: { name: 'Windows' }, cpu: { cores: 8, threads: 16 }, ramMb: 32768, gpus: gpu ? [{ name: 'GPU', vendor: 'NVIDIA', vramMb: 12288 }] : [] },
    capacity: { cpuCores: 4, ramMb: 8192, gpuPercent: gpu ? 80 : 0, vramMb: gpu ? 12288 : 0, diskMb: 10_000, maxTemperatureC: 85 },
    usage: { cpuPercent: 5, cpuGhostPercent: 0, temperatureC: 50 },
    reserved: zeroResources(),
    activeAssignments: 0,
    recent: { completed: 0, failed: 0 },
    performance: toPerformanceView(p, p?.verified ?? false, {}),
  };
}
const inferenceJob = (id: string, items: number, over: Partial<JobSpec> = {}): JobSpec => ({
  id,
  type: 'image-inference',
  priority: 50,
  requirements: {},
  resources: { cpuCores: 1, ramMb: 512, gpu: false, vramMb: 0, diskMb: 0 },
  createdAt: NOW,
  excludedWorkers: [],
  timeoutSeconds: 600,
  work: { items, bytes: items * 20_000, accelerator: 'auto' },
  ...over,
});
const benchJob: JobSpec = { ...inferenceJob('bench', 0), type: 'benchmark', work: undefined };

describe('scheduler uses the profile, not just "has a GPU"', () => {
  const lan = { rttMs: 1, downloadMbps: 1000 };
  const fastGpu = snapshot('a-fast-gpu', { gpuGflops: 20_000, inferGpu: 8000, inferCpu: 100, ...lan }, true);
  const slowGpu = snapshot('b-slow-gpu', { gpuGflops: 800, inferGpu: 900, inferCpu: 100, ...lan }, true);
  const brokenGpu = snapshot('c-broken-gpu', { gpuGflops: 20_000, inferGpu: 8000, wrongGpuChecksum: true, inferCpu: 100, ...lan }, true);
  const fastCpu = snapshot('d-fast-cpu', { cpuFactor: 3, inferCpu: 300, ...lan });
  const slowCpu = snapshot('e-slow-cpu', { cpuFactor: 0.3, inferCpu: 60, rttMs: 150, downloadMbps: 5 });
  const unknown = snapshot('f-uncalibrated', null);
  const fleet = [unknown, slowCpu, fastCpu, brokenGpu, slowGpu, fastGpu];
  const s = weightedStrategy();
  const place = (j: JobSpec) => s.place([j], fleet, opts).placements[0]?.workerId;

  it('GPU jobs go to the fastest verified GPU; a GPU that failed calibration is skipped', () => {
    const gpuJob = inferenceJob('g', 256, { resources: { cpuCores: 1, ramMb: 512, gpu: true, vramMb: 0, diskMb: 0 }, work: { items: 256, bytes: 5e6, accelerator: 'gpu' } });
    expect(place(gpuJob)).toBe('a-fast-gpu');
    expect(ineligibility(gpuJob, brokenGpu, opts)).toBe('GPU_UNVERIFIED');
    expect(ineligibility(gpuJob, unknown, opts)).toBe('NO_GPU');
    const r = s.place([gpuJob], [brokenGpu, slowGpu], opts);
    expect(r.placements[0]?.workerId).toBe('b-slow-gpu');
  });

  it('big "auto" batches prefer the fastest measured path; benchmark jobs the fastest CPU', () => {
    expect(place(inferenceJob('auto', 256))).toBe('a-fast-gpu');
    // Network-bound batch (slow link): a GPU does not help, the free CPU box is as good.
    const wan = { rttMs: 80, downloadMbps: 20 };
    const r = s.place([inferenceJob('wan', 256)], [snapshot('g', { gpuGflops: 20_000, inferGpu: 8000, inferCpu: 400, ...wan }, true), snapshot('c', { inferCpu: 400, ...wan })], opts);
    expect(r.placements[0]?.workerId).toBe('c');
    expect(place(benchJob)).toBe('d-fast-cpu');
    // CPU-only inference: fastest CPU inference, not the GPU box.
    const cpuOnly = inferenceJob('cpu', 256, { work: { items: 256, bytes: 5e6, accelerator: 'cpu' } });
    expect(place(cpuOnly)).toBe('d-fast-cpu');
  });

  it('estimates include compute, transfer and latency; too slow for the timeout is ineligible', () => {
    const j = inferenceJob('t', 256, { timeoutSeconds: 30 });
    const fast = estimateSeconds(j, fastGpu)!;
    const slow = estimateSeconds(j, slowCpu)!;
    expect(fast).toBeLessThan(5);
    expect(slow).toBeGreaterThan(30);
    expect(ineligibility(j, slowCpu, opts)).toBe('TOO_SLOW');
    expect(ineligibility(j, fastGpu, opts)).toBeNull();
    expect(estimateSeconds(j, unknown)).toBeNull();
    expect(ineligibility(j, unknown, opts)).toBeNull(); // no basis: allowed, but ranked low
    expect(performanceComponent(j, unknown)).toBeLessThan(performanceComponent(j, slowGpu));
  });

  it('real-job throughput overrides an optimistic benchmark', () => {
    const j = inferenceJob('o', 256);
    const liar: WorkerSnapshot = {
      ...fastGpu,
      id: 'z-liar',
      performance: { ...fastGpu.performance!, observed: { 'image-inference': { itemsPerSec: 20, samples: 5 } } },
    };
    expect(estimateSeconds(j, liar)).toBeCloseTo(0.5 + 256 / 20); // measured start-up + observed rate
    expect(s.place([j], [liar, fastCpu], opts).placements[0]?.workerId).toBe('d-fast-cpu');
    // Two samples are not enough yet.
    const early = { ...liar, performance: { ...liar.performance!, observed: { 'image-inference': { itemsPerSec: 20, samples: 2 } } } };
    expect(s.place([j], [early, fastCpu], opts).placements[0]?.workerId).toBe('z-liar');
  });

  it('placement is reproducible', () => {
    const jobs = Array.from({ length: 6 }, (_, i) => inferenceJob(`j${i}`, 64 * (i + 1)));
    const a = s.place(jobs, fleet, opts);
    expect(s.place(jobs, [...fleet].reverse(), opts)).toEqual(a);
  });
});

// ---- API ---------------------------------------------------------------------------------

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
beforeEach(async () => {
  await reset(h.rt);
  h.adminToken = (await createUserWithToken(h.rt, { email: 'a@ghost.test', role: 'admin', tokenName: 't' }, null)).token;
});
afterAll(() => h.close());

describe('calibration protocol', () => {
  it('runs when a worker joins and produces a profile', async () => {
    const w = await registerWorker(h, { name: 'rtx' });
    // Paused owner: never benchmarked.
    expect((await heartbeat(h, w, { state: 'paused' })).json().calibration).toBeUndefined();

    const hb = (await heartbeat(h, w, { agentVersion: '0.1.0' })).json();
    expect(hb.calibration).toMatchObject({ reason: 'first-join', params: DEFAULT_PARAMS });
    // Same open request until it is done.
    expect((await heartbeat(h, w)).json().calibration.id).toBe(hb.calibration.id);

    const ping = await h.app.inject({ url: '/v1/worker/calibration/ping', headers: auth(w.token) });
    expect(ping.statusCode).toBe(200);
    const dl = await h.app.inject({ url: `/v1/worker/calibration/${hb.calibration.id}/download`, headers: auth(w.token) });
    expect(dl.rawPayload.equals(streamBytes(hb.calibration.nonce, 8 << 20))).toBe(true);
    const other = await registerWorker(h, { name: 'other' });
    expect((await h.app.inject({ url: `/v1/worker/calibration/${hb.calibration.id}/download`, headers: auth(other.token) })).statusCode).toBe(404);

    // Wrong upload bytes are detected by the server.
    const badUp = await h.app.inject({
      method: 'POST',
      url: `/v1/worker/calibration/${hb.calibration.id}/upload`,
      headers: { ...auth(w.token), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1000),
    });
    expect(badUp.json().ok).toBe(false);

    const { result } = await calibrate(h, w, { gpuGflops: 20_000, inferGpu: 8000 });
    expect(result.status).toBe('COMPLETED');
    expect((await heartbeat(h, w, { agentVersion: '0.1.0' })).json().calibration).toBeUndefined();

    const prof = (await h.app.inject({ url: `/v1/workers/${w.id}/profile`, headers: auth(h.adminToken) })).json();
    expect(prof.summary).toMatchObject({
      gpu: 'NVIDIA GeForce RTX 4070',
      vram: '12 GB',
      averageLatencyMs: 21,
      verified: true,
    });
    expect(prof.summary.scoreInference).toBeCloseTo(16_000, -3);
    expect(prof.summary.throughputItemsPerSec).toBeCloseTo(8000, -2);
    expect(prof.calibrations[0]).toMatchObject({ reason: 'first-join', status: 'COMPLETED', issues: [] });

    // A new agent version recalibrates.
    expect((await heartbeat(h, w, { agentVersion: '0.2.0' })).json().calibration.reason).toBe('agent-updated');
  });

  it('a report that fails verification leaves the worker uncalibrated and backs off', async () => {
    const w = await registerWorker(h, { name: 'liar' });
    const { result } = await calibrate(h, w, { wrongCpuChecksum: true });
    expect(result).toMatchObject({ status: 'FAILED', issues: expect.arrayContaining(['CPU_CHECKSUM:hash']) });
    const row = (await h.rt.db.query(`SELECT verified, profile FROM worker_performance WHERE worker_id = $1`, [w.id])).rows[0];
    expect(row.verified).toBe(false);
    expect(toPerformanceView(row.profile, row.verified, {})).toBeNull();
    // No immediate retry loop.
    expect((await heartbeat(h, w, { agentVersion: '0.1.0' })).json().calibration).toBeUndefined();
    // Strict schema: unknown fields are refused.
    const req = (await h.app.inject({ method: 'POST', url: `/v1/workers/${w.id}/calibrate`, headers: auth(h.adminToken) })).json();
    const bad = await h.app.inject({
      method: 'POST',
      url: `/v1/worker/calibration/${req.calibrationId}/report`,
      headers: auth(w.token),
      payload: { ...syntheticReport(DEFAULT_PARAMS, 'x'), shell: 'rm -rf /' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('operators can force a recalibration; viewers cannot', async () => {
    const w = await registerWorker(h, { name: 'pc' });
    await calibrate(h, w);
    const viewer = await makeUser(h, 'viewer');
    expect((await h.app.inject({ method: 'POST', url: `/v1/workers/${w.id}/calibrate`, headers: auth(viewer) })).statusCode).toBe(403);
    const r = await h.app.inject({ method: 'POST', url: `/v1/workers/${w.id}/calibrate`, headers: auth(h.adminToken) });
    expect(r.statusCode).toBe(202);
    expect((await heartbeat(h, w)).json().calibration.id).toBe(r.json().calibrationId);
  });

  it('expired requests are closed and retried later', async () => {
    const w = await registerWorker(h, { name: 'slow' });
    const first = (await heartbeat(h, w)).json().calibration;
    await h.rt.db.query(`UPDATE worker_calibrations SET deadline = now() - interval '1 second'`);
    expect((await heartbeat(h, w)).json().calibration).toBeUndefined();
    await h.rt.db.query(`UPDATE worker_calibrations SET requested_at = now() - interval '1 hour'`);
    const again = (await heartbeat(h, w)).json().calibration;
    expect(again.id).not.toBe(first.id);
  });

  it('real jobs update the observed throughput', async () => {
    const w = await registerWorker(h, { name: 'obs' });
    await calibrate(h, w);
    const { CalibrationService } = await import('../src/performance/service.js');
    const svc = new CalibrationService(h.rt);
    await svc.recordObservation(w.id, 'image-inference', 100, 2);
    await svc.recordObservation(w.id, 'image-inference', 100, 1);
    const { observed } = (await h.rt.db.query(`SELECT observed FROM worker_performance WHERE worker_id = $1`, [w.id])).rows[0];
    // Start-up (0.5 s from the calibration) removed: 100/1.5 = 66.67, then 0.3·200 + 0.7·66.67 = 106.67.
    expect(observed['image-inference']).toMatchObject({ itemsPerSec: 106.67, samples: 2 });
  });
});

void REFERENCE;
