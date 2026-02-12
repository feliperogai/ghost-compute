// In-browser stand-in for the agent: development, screenshots and component tests.
// Starts from a status captured from a real agent (fixtures/status.agent.json).
import fixture from './fixtures/status.agent.json';
import { AgentError, type AgentApi } from './api';
import type { ActiveWorkload, ControlAction, Limits, Status } from './types';

export type Scenario = 'waiting' | 'stopped' | 'paused' | 'ready' | 'running' | 'reconnecting' | 'noagent' | 'hot';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const demoWorkload: ActiveWorkload = {
  assignmentId: '5b0e4d1c-4a1b-4b61-9a51-0c9f6f1a2b3c',
  jobId: '9c7d7a1e-2f3b-4c5d-8e9f-0a1b2c3d4e5f',
  jobName: 'Simulação Monte Carlo — lote 14',
  type: 'wasm-cpu',
  progress: 0.42,
  stage: 'amostrando',
  startedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
};

export function scenarioStatus(s: Scenario): Status {
  const st = clone(fixture) as unknown as Status;
  // A richer machine than the CI box the fixture came from.
  st.hardware.gpus = [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', vramMb: 12282 }];
  st.hardware.cpu = { ...st.hardware.cpu, model: 'AMD Ryzen 7 7700X 8-Core Processor', cores: 8, threads: 16 };
  st.hardware.ramMb = 32_768;
  const u = st.usage;
  for (const x of [u.latest, u.avg]) {
    Object.assign(x, {
      cpuPercent: 18,
      cpuGhostPercent: 0,
      ramTotalMb: 32_768,
      ramUsedMb: 11_200,
      ramGhostMb: 24,
      gpuPercent: 7,
      gpuMemoryUsedMb: 1_450,
      temperatureC: 54,
    });
  }
  u.maxTemperatureC = 56;
  st.limits = { ...st.limits, max_cpu_percent: 40, max_ram_mb: 4096, max_gpu_percent: 30, max_temperature_c: 80 };
  st.stats = {
    tasks: { succeeded: 128, failed: 3, preempted: 11, active: 0 },
    computeSeconds: 41_760,
    credits: 696,
    recent: [
      {
        assignmentId: 'a1',
        jobId: 'j1',
        jobName: 'Simulação Monte Carlo — lote 13',
        type: 'wasm-cpu',
        attempt: 1,
        status: 'completed',
        progress: 1,
        stage: null,
        assignedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
        startedAt: new Date(Date.now() - 49 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 38 * 60_000).toISOString(),
      },
      {
        assignmentId: 'a2',
        jobId: 'j2',
        jobName: 'Hash de verificação',
        type: 'wasm-cpu',
        attempt: 2,
        status: 'lost',
        progress: 0.6,
        stage: null,
        assignedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        finishedAt: new Date(Date.now() - 2.9 * 3600_000).toISOString(),
      },
    ],
  };
  st.reasons = [];
  st.connection = { status: 'connected', lastContactAt: new Date().toISOString(), lastError: null };
  switch (s) {
    case 'stopped':
      Object.assign(st, { control: 'stopped', state: 'stopped', reasons: [{ reason: 'stopped_by_owner' }] });
      break;
    case 'paused':
      Object.assign(st, { control: 'paused', state: 'paused', reasons: [{ reason: 'paused_by_owner' }] });
      break;
    case 'ready':
      Object.assign(st, { control: 'started', state: 'available' });
      break;
    case 'waiting':
      Object.assign(st, {
        control: 'started',
        state: 'waiting',
        reasons: [{ reason: 'owner_active', idle_secs: 14, required: 300 }, { reason: 'game_running' }],
      });
      break;
    case 'hot':
      Object.assign(st, {
        control: 'started',
        state: 'waiting',
        reasons: [{ reason: 'too_hot', celsius: 86, limit: 80 }],
      });
      u.maxTemperatureC = 86;
      break;
    case 'running':
      Object.assign(st, { control: 'started', state: 'running', workloads: [demoWorkload] });
      for (const x of [u.latest, u.avg]) Object.assign(x, { cpuPercent: 52, cpuGhostPercent: 37, ramGhostMb: 2_380 });
      st.stats.tasks.active = 1;
      break;
    case 'reconnecting':
      st.connection = {
        status: 'reconnecting',
        lastContactAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        lastError: 'network error: connection refused',
      };
      Object.assign(st, { control: 'started', state: 'waiting', reasons: [{ reason: 'outside_schedule' }] });
      break;
    case 'noagent':
      break;
  }
  return st;
}

export class MockAgent implements AgentApi {
  private st: Status;
  calls: string[] = [];

  constructor(private scenario: Scenario = 'waiting') {
    this.st = scenarioStatus(scenario);
  }

  async status(): Promise<Status> {
    if (this.scenario === 'noagent') throw new AgentError('AGENT_UNREACHABLE', 'agent not reachable');
    return { ...clone(this.st), generatedAt: new Date().toISOString() };
  }

  async control(action: ControlAction): Promise<Status> {
    this.calls.push(`control:${action}`);
    if (action === 'stop') Object.assign(this.st, { control: 'stopped', state: 'stopped', workloads: [], reasons: [] });
    if (action === 'pause') Object.assign(this.st, { control: 'paused', state: 'paused', workloads: [], reasons: [] });
    if (action === 'start')
      Object.assign(this.st, { control: 'started', state: 'waiting', reasons: [{ reason: 'cooling_down', remaining_secs: 60 }] });
    return this.status();
  }

  async saveSettings(limits: Limits): Promise<Limits> {
    this.calls.push('saveSettings');
    // Mirror the agent's main validation so the UI error path is exercised.
    if (limits.max_cpu_percent < 0 || limits.max_cpu_percent > 100)
      throw new AgentError('INVALID_SETTINGS', 'invalid config: limits.max_cpu_percent must be 0..=100');
    this.st.limits = clone(limits);
    return clone(limits);
  }
}
