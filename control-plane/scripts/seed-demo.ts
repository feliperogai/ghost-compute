/**
 * Fills an EMPTY development database with a demo network and 24 h of metrics, so the
 * dashboard can be seen and debugged without real machines. Never run it against a
 * real deployment: it refuses if the database already has workers.
 * Usage: DATABASE_URL=... npx tsx scripts/seed-demo.ts
 */
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildProfile } from '../src/performance/profile.js';
import { DEFAULT_PARAMS } from '../src/performance/suite.js';
import { hardwareSha256 } from '../src/performance/service.js';
import { syntheticReport } from '../test/calibration-fixtures.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createPool(url);
// Deterministic pseudo-random numbers: the same demo every time.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const machines = [
  { name: 'escritorio-01', cpu: 'AMD Ryzen 7 5800X', threads: 16, ram: 32768, gpu: { name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', vramMb: 12282 }, base: 18, temp: 58,
    speeds: { cpuFactor: 1.8, inferCpu: 3200, gpuGflops: 21_000, inferGpu: 9000, rttMs: 4, downloadMbps: 900 } },
  { name: 'lab-03', cpu: 'Intel Core i5-12400', threads: 12, ram: 16384, gpu: null, base: 30, temp: 64, speeds: { cpuFactor: 1.4, inferCpu: 2400, rttMs: 6, downloadMbps: 400 } },
  { name: 'casa-joao', cpu: 'Intel Core i7-9700K', threads: 8, ram: 16384, gpu: { name: 'NVIDIA GeForce GTX 1660', vendor: 'NVIDIA', vramMb: 6144 }, base: 45, temp: 71,
    speeds: { cpuFactor: 1.1, inferCpu: 1700, gpuGflops: 4_500, inferGpu: 3000, rttMs: 38, downloadMbps: 60 } },
  { name: 'notebook-ana', cpu: 'AMD Ryzen 5 5600U', threads: 12, ram: 8192, gpu: null, base: 22, temp: 79, speeds: { cpuFactor: 0.9, inferCpu: 1100, rttMs: 25, downloadMbps: 80 } },
  { name: 'recepcao', cpu: 'Intel Core i3-10100', threads: 8, ram: 8192, gpu: null, base: 12, temp: 52, speeds: null },
];

try {
  await migrate(db);
  if ((await db.query(`SELECT count(*)::int AS n FROM workers`)).rows[0].n > 0) throw new Error('database already has workers; refusing to seed');
  const owner = (await db.query(`INSERT INTO users (email, role) VALUES ('demo-owner@ghost.test', 'operator') RETURNING id`)).rows[0].id;
  const now = Date.now();
  const ids: string[] = [];
  for (const [i, m] of machines.entries()) {
    const offline = i === 4;
    const id = randomUUID();
    ids.push(id);
    const hw = { cpu: { model: m.cpu, cores: m.threads / 2, threads: m.threads, features: ['avx2'] }, ramMb: m.ram, gpus: m.gpu ? [m.gpu] : [], os: { name: 'Windows', version: '11 23H2' }, diskFreeMb: 200_000 };
    const cap = { cpuCores: m.threads / 4, ramMb: m.ram / 2, gpuPercent: m.gpu ? 70 : 0, vramMb: m.gpu?.vramMb ?? 0, diskMb: 20_000, maxTemperatureC: 85 };
    await db.query(
      `INSERT INTO workers (id, name, device_id, owner_user_id, secret_hash, status, state, max_concurrent_tasks, hardware, capacity,
                            workload_types, agent_version, last_seen_at, online_since, last_usage)
       VALUES ($1, $2, $3, $4, 'x', 'active', $5, 2, $6, $7, '{benchmark,image-inference}', '0.1.0', $8, $9, $10)`,
      [id, m.name, randomUUID(), owner, offline ? 'offline' : i === 0 ? 'running' : 'available', hw, cap,
       new Date(offline ? now - 3 * 3600e3 : now - 2000), offline ? null : new Date(now - (i + 1) * 5 * 3600e3),
       { cpuPercent: m.base + 8, cpuGhostPercent: i === 0 ? 20 : 0, ramUsedMb: m.ram * 0.45, ramGhostMb: 300, temperatureC: m.temp, ...(m.gpu ? { gpuPercent: i === 0 ? 55 : 5 } : {}) }],
    );
    if (m.speeds) {
      const profile = buildProfile(syntheticReport(DEFAULT_PARAMS, 'demo', m.speeds), DEFAULT_PARAMS, 'demo',
        { upload: { bytes: 8 << 20, elapsedMs: Math.round((8 * 8) / (m.speeds.downloadMbps / 2) * 1000), ok: true } }, hw, new Date(now - 4 * 3600e3));
      await db.query(
        `INSERT INTO worker_performance (worker_id, profile, verified, agent_version, hardware_sha256, calibrated_at, observed)
         VALUES ($1, $2, $3, '0.1.0', $4, now() - interval '4 hours', $5)`,
        [id, profile, profile.verified, hardwareSha256(hw), { 'image-inference': { itemsPerSec: Math.round(m.speeds.inferCpu / 12), samples: 7, updatedAt: new Date().toISOString() } }],
      );
    }
    // One sample per minute for 24 h (offline machine stops 3 h ago).
    const rows: unknown[][] = [];
    for (let t = now - 86400e3; t <= now - (offline ? 3 * 3600e3 : 0); t += 60e3) {
      const day = Math.sin(((t / 3600e3) % 24) / 24 * 2 * Math.PI);
      const busy = (t / 3600e3) % 5 < 2;
      const cpu = Math.min(100, m.base + 15 * day + 10 * rnd() + (busy ? 25 : 0));
      rows.push([id, new Date(t), busy ? 'running' : 'available', cpu, busy ? 22 + 5 * rnd() : 1, Math.round(m.ram * (0.4 + 0.1 * day)), busy ? 400 : 60,
        m.gpu ? (busy ? 50 + 20 * rnd() : 3) : null, m.temp + 6 * day + (busy ? 6 : 0) + 2 * rnd(), busy ? 1 : 0]);
    }
    for (let k = 0; k < rows.length; k += 500) {
      const chunk = rows.slice(k, k + 500);
      await db.query(
        `INSERT INTO worker_metrics (worker_id, ts, state, cpu_percent, cpu_ghost_percent, ram_used_mb, ram_ghost_mb, gpu_percent, temperature_c, active_assignments)
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::real[], $5::real[], $6::int[], $7::int[], $8::real[], $9::real[], $10::int[])`,
        Array.from({ length: 10 }, (_, c) => chunk.map((r) => r[c])),
      );
    }
  }
  // Network and API history.
  for (let t = now - 86400e3; t <= now; t += 60e3) {
    const day = Math.sin(((t / 3600e3) % 24) / 24 * 2 * Math.PI);
    const online = t > now - 3 * 3600e3 ? 4 : 5;
    await db.query(
      `INSERT INTO network_metrics VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
      [new Date(Math.floor(t / 60e3) * 60e3), online, 5 - online, { available: online - 1, running: 1, offline: 5 - online }, online === 5 ? 14 : 12,
       online === 5 ? 40960 : 36864, 2, 18426, Math.max(0, Math.round(6 + 6 * day + 4 * rnd())), 2 + Math.round(rnd() * 2),
       Math.round(3 + 2 * day + 2 * rnd()), rnd() < 0.08 ? 1 : 0, 0.4 + rnd(), 1.5 + 3 * rnd()],
    );
    const b = new Array(12).fill(0);
    const req = Math.round(60 + 30 * day + 20 * rnd());
    for (let r = 0; r < req; r++) b[rnd() < 0.7 ? 1 : rnd() < 0.8 ? 3 : rnd() < 0.9 ? 5 : 7]++;
    await db.query(
      `INSERT INTO api_metrics VALUES ('demo', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [new Date(Math.floor(t / 60e3) * 60e3), req, Math.round(rnd() * 2), rnd() < 0.02 ? 1 : 0, b],
    );
  }
  // A few jobs, attempts and errors to debug.
  const job = async (status: string, worker: string | null, error: string | null, ago: number) => {
    const j = (await db.query(
      `INSERT INTO jobs (owner_id, name, type, resources, status, timeout_seconds, input, worker_id, created_at, finished_at, error, pending_reason)
       VALUES ($1, $2, 'benchmark', '{"cpuCores":1,"ramMb":512,"gpu":false,"vramMb":0,"diskMb":0}', $3, 600, '{"kind":"hash","iterations":1000}', $4,
               now() - make_interval(secs => $5), CASE WHEN $3 IN ('COMPLETED','FAILED') THEN now() - make_interval(secs => $5 - 30) END, $6, $7) RETURNING id`,
      [owner, `demo ${status.toLowerCase()}`, status, worker, ago, error ? { code: 'JOB_FAILED', message: error } : null, status === 'QUEUED' ? 'no eligible worker (2× TOO_HOT, 1× NO_SLOTS)' : null],
    )).rows[0].id;
    if (worker)
      await db.query(
        `INSERT INTO job_assignments (job_id, worker_id, attempt, status, strategy, score, score_detail, reserved, accept_deadline, assigned_at, started_at, finished_at, error)
         VALUES ($1, $2, 1, $3, 'score', 0.55, '{}', '{}', now(), now() - make_interval(secs => $4), now() - make_interval(secs => $4 - 2),
                 CASE WHEN $3 IN ('completed','failed') THEN now() - make_interval(secs => $4 - 30) END, $5)`,
        [j, worker, status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'running', ago, error],
      );
    if (worker) {
      const name = machines[ids.indexOf(worker)]!.name;
      await db.query(
        `INSERT INTO scheduler_decisions (job_id, worker_id, strategy, score, summary, explanation, created_at)
         VALUES ($1, $2, 'score', 0.55, $3, '{}', now() - make_interval(secs => $4))`,
        [j, worker, `Worker ${name} (${worker.slice(0, 8)}) foi escolhido porque desempenho medido melhor (0,62; fonte: benchmark); menor latência (4 ms vs 25 ms); menos carregado (dono usando 18% vs 45% de CPU, 0/2 vagas, 58 °C). Score 0,561 contra 0,448 de lab-03 (margem 0,113). 1 worker(s) descartado(s): 1× offline. Prioridade 50 (normal).`, ago],
      );
    }
    return j;
  };
  for (let k = 0; k < 6; k++) await job('COMPLETED', ids[k % 3]!, null, 600 + k * 400);
  await job('FAILED', ids[2]!, 'sandbox crashed or was killed by the OS (exit code: 3221225477)', 900);
  await job('FAILED', ids[3]!, 'input download failed: image 12: HTTP 409 Conflict: ASSIGNMENT_NOT_ACTIVE', 2500);
  await job('RUNNING', ids[0]!, null, 40);
  for (let k = 0; k < 3; k++) await job('QUEUED', null, null, 120);
  await db.query(`INSERT INTO api_errors (ts, method, route, status, request_id, code, message) VALUES (now() - interval '25 minutes', 'POST', '/v1/worker/heartbeat', 500, $1, 'ECONNRESET', 'Connection terminated unexpectedly')`, [randomUUID()]);
  console.log(`seeded ${machines.length} workers with 24 h of history`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
