// Scheduler domain types. No framework or database imports: this module is the
// replaceable "brain"; persistence and transport live behind ./ports.ts.

export const JOB_STATUSES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];
export const isTerminal = (s: JobStatus) => TERMINAL_STATUSES.includes(s);

/** Capabilities a worker must have. */
export interface Requirements {
  os?: 'windows' | 'linux' | 'macos';
  cpuFeatures?: string[];
  minCpuCores?: number;
  minRamMb?: number;
  gpuVendor?: 'NVIDIA' | 'AMD' | 'Intel';
  minVramMb?: number;
}

/** What the job reserves on the worker while it runs. */
export interface Resources {
  cpuCores: number;
  ramMb: number;
  gpu: boolean;
  vramMb: number;
  diskMb: number;
}

/** A job as the scheduler sees it. */
export interface JobSpec {
  id: string;
  type: string;
  priority: number;
  requirements: Requirements;
  resources: Resources;
  createdAt: Date;
  /** Workers this job must not go to (failed on it, or recently declined it). */
  excludedWorkers: string[];
}

/** What a worker offers to the network (owner limits applied by the agent). */
export interface Capacity {
  cpuCores: number;
  ramMb: number;
  gpuPercent: number;
  vramMb: number;
  diskMb: number;
  maxTemperatureC: number;
}

export interface WorkerSnapshot {
  id: string;
  /** Agent-reported state. Only `available` / `running` accept new work. */
  state: string;
  lastSeenAt: Date | null;
  maxConcurrent: number;
  workloadTypes: string[];
  hardware: {
    os?: { name?: string };
    cpu?: { cores?: number; threads?: number; features?: string[] };
    ramMb?: number;
    gpus?: { name?: string; vendor?: string; vramMb?: number }[];
  };
  /** Null until the agent reports it: such workers never receive jobs. */
  capacity: Capacity | null;
  usage: { cpuPercent?: number; cpuGhostPercent?: number; gpuPercent?: number; temperatureC?: number } | null;
  /** Resources held by active assignments. */
  reserved: Resources;
  activeAssignments: number;
  /** Recent outcomes on this worker, for reliability scoring. */
  recent: { completed: number; failed: number };
}

export type IneligibleReason =
  | 'OFFLINE'
  | 'NOT_ACCEPTING'
  | 'NO_CAPACITY_REPORTED'
  | 'TYPE_UNSUPPORTED'
  | 'OS_MISMATCH'
  | 'CPU_FEATURES'
  | 'INSUFFICIENT_CPU'
  | 'INSUFFICIENT_RAM'
  | 'NO_GPU'
  | 'GPU_VENDOR'
  | 'INSUFFICIENT_VRAM'
  | 'INSUFFICIENT_DISK'
  | 'TOO_HOT'
  | 'NO_SLOTS'
  | 'EXCLUDED';

export interface ScoreBreakdown {
  total: number;
  components: Record<string, number>;
}

export interface Placement {
  jobId: string;
  workerId: string;
  score: ScoreBreakdown;
}

export interface Unplaced {
  jobId: string;
  /** Counts of why workers were rejected, for an explainable pending reason. */
  reasons: Partial<Record<IneligibleReason, number>>;
}

export interface PlacementResult {
  placements: Placement[];
  unplaced: Unplaced[];
}

export const zeroResources = (): Resources => ({ cpuCores: 0, ramMb: 0, gpu: false, vramMb: 0, diskMb: 0 });
