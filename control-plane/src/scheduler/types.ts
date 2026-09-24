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
  /** Max running time of one attempt, seconds. */
  timeoutSeconds?: number;
  /** How much work the job carries, when the type knows (for time estimates). */
  work?: WorkSize;
}

export interface WorkSize {
  items: number;
  bytes: number;
  accelerator?: 'cpu' | 'auto' | 'gpu';
}

/**
 * What the scheduler knows about a worker's measured speed (from its calibration
 * profile and from real jobs). Null: never calibrated, or the calibration did not verify.
 */
export interface PerformanceView {
  /** 1000 = reference machine. */
  cpuScore: number;
  inference: { cpuItemsPerSec: number; gpuItemsPerSec: number | null; cpuStartupMs?: number; gpuStartupMs?: number | null };
  gpu: { verified: boolean; vramAvailableMb: number | null; nvidia: boolean } | null;
  network: { latencyMs: number; downloadMbps: number | null };
  /** Throughput seen on real jobs of each type (EWMA). */
  observed: Record<string, { itemsPerSec: number; samples: number }>;
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
  /** Display name (explanations only). */
  name?: string;
  /** Start of the current uninterrupted online period. */
  onlineSince?: Date | null;
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
  /** Measured performance; absent/null until the worker is calibrated. */
  performance?: PerformanceView | null;
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
  | 'GPU_NOT_CALIBRATED'
  | 'GPU_UNVERIFIED'
  | 'TOO_SLOW'
  | 'GPU_VENDOR'
  | 'INSUFFICIENT_VRAM'
  | 'INSUFFICIENT_DISK'
  | 'TOO_HOT'
  | 'NO_SLOTS'
  | 'EXCLUDED';

export interface ScoreTerm {
  /** Normalized to [0, 1]. */
  value: number;
  weight: number;
  /** ± weight × value (penalties are negative). */
  contribution: number;
  /** Raw inputs behind the value, for the explanation. */
  factors: Record<string, number | string | null>;
}

export interface ScoreBreakdown {
  total: number;
  components: Record<string, number>;
  terms?: Record<string, ScoreTerm>;
}

/** Why a worker was chosen: stored with every placement ("Worker X foi escolhido porque..."). */
export interface DecisionExplanation {
  summary: string;
  reasons: string[];
  formula: string;
  priorityBand: string;
  weights: Record<string, number>;
  chosen: { workerId: string; name: string | null; total: number; terms: Record<string, ScoreTerm> };
  runnerUp: { workerId: string; name: string | null; total: number; margin: number } | null;
  candidates: { workerId: string; name: string | null; total: number; components: Record<string, number> }[];
  rejected: Partial<Record<IneligibleReason, number>>;
}

export interface Placement {
  jobId: string;
  workerId: string;
  score: ScoreBreakdown;
  explanation?: DecisionExplanation;
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
