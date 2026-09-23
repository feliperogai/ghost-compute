// Mirrors the agent's IPC `status` payload (agent/src/runtime/mod.rs).
// Contract fixture captured from a real agent: src/fixtures/status.agent.json.

export type OwnerControl = 'started' | 'paused' | 'stopped';
export type WorkerState = 'waiting' | 'available' | 'running' | 'paused' | 'stopped';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'revoked' | 'invalid_credentials';
export type ControlAction = 'start' | 'pause' | 'stop';

export type Reason =
  | { reason: 'disabled' }
  | { reason: 'paused_by_owner' }
  | { reason: 'stopped_by_owner' }
  | { reason: 'outside_schedule' }
  | { reason: 'on_battery' }
  | { reason: 'too_hot'; celsius: number; limit: number }
  | { reason: 'owner_cpu_busy'; percent: number; limit: number }
  | { reason: 'ram_pressure'; percent: number; limit: number }
  | { reason: 'owner_active'; idle_secs: number; required: number }
  | { reason: 'session_unlocked' }
  | { reason: 'game_running' }
  | { reason: 'priority_app_running'; app: string }
  | { reason: 'cooling_down'; remaining_secs: number }
  | { reason: 'execution_unavailable' }
  | { reason: 'no_data' };

export interface Sample {
  cpuPercent: number;
  cpuGhostPercent: number;
  ramTotalMb: number;
  ramUsedMb: number;
  ramGhostMb: number;
  gpuPercent: number | null;
  gpuMemoryUsedMb: number | null;
  temperatureC: number | null;
  userIdleSecs: number | null;
  onBattery: boolean | null;
}

export interface Gpu {
  name: string;
  vendor?: string;
  vramMb?: number;
}

export interface Hardware {
  cpu: { model: string; cores: number; threads: number; features: string[] };
  ramMb: number;
  gpus: Gpu[];
  os: { name: string; version: string };
  diskFreeMb: number;
}

export interface ScheduleWindow {
  days: string[];
  from: string;
  to: string;
}

/** snake_case: same keys as agent.toml [limits]. */
export interface Limits {
  enabled: boolean;
  max_cpu_percent: number;
  max_ram_mb: number;
  max_gpu_percent: number;
  max_temperature_c: number;
  user_cpu_threshold_percent: number;
  user_ram_threshold_percent: number;
  require_idle_secs: number;
  resume_after_secs: number;
  pause_on_battery: boolean;
  only_when_locked: boolean;
  pause_during_games: boolean;
  priority_apps: string[];
  schedule: ScheduleWindow[];
}

export interface ModuleRef {
  name: string;
  version: string;
}

export interface ActiveWorkload {
  leaseId: string;
  jobId: string;
  jobName: string;
  module: ModuleRef;
  progress: number;
  stage: string | null;
  startedAt: string;
}

export interface RecentTask {
  leaseId: string;
  jobId: string;
  jobName: string;
  module: ModuleRef;
  taskIndex: number;
  status: string;
  progress: number;
  stage: string | null;
  offeredAt: string;
  acceptedAt: string | null;
  finishedAt: string | null;
}

export interface WorkerStats {
  tasks: { succeeded: number; failed: number; preempted: number; active: number };
  computeSeconds: number;
  credits: number;
  recent: RecentTask[];
}

export interface Status {
  agent: {
    version: string;
    name: string;
    workerId: string;
    deviceId: string;
    serverUrl: string;
    executionAvailable: boolean;
  };
  connection: { status: ConnectionStatus; lastContactAt: string | null; lastError: string | null };
  control: OwnerControl;
  state: WorkerState | null;
  reasons: Reason[];
  hardware: Hardware;
  usage: { latest: Sample; avg: Sample; maxTemperatureC: number | null; samples: number };
  limits: Limits;
  presence: { idleSecs: number | null; locked: boolean | null; fullscreenApp: boolean | null };
  workloads: ActiveWorkload[];
  stats: WorkerStats | null;
  generatedAt: string;
}
