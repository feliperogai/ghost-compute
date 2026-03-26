export interface ErrorItem {
  kind: 'api' | 'attempt' | 'calibration';
  at: string | null;
  workerId: string | null;
  workerName: string | null;
  jobId: string | null;
  source: string;
  code: string;
  message: string | null;
  ref: string | null;
}

export interface Overview {
  generatedAt: string;
  network: {
    workersOnline: number;
    workersOffline: number;
    workersByState: Record<string, number>;
    cpu: { offeredCores: number; threads: number };
    ram: { offeredMb: number; installedMb: number };
    gpu: { shared: number; installed: number };
    vram: { offeredMb: number; installedMb: number };
  };
  jobs: {
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    failed: number;
    timeout: number;
    cancelled: number;
    lastHour: { completed: number; failed: number };
    pendingReasons: { reason: string; jobs: number }[];
  };
  system: {
    api: {
      requests: number;
      requestsPerMinute: number;
      errors4xx: number;
      errors5xx: number;
      errorRate: number;
      latencyP50Ms: number | null;
      latencyP95Ms: number | null;
      latencyP99Ms: number | null;
    };
    attemptsLastHour: { completed: number; failed: number; failureRate: number };
    throughputPerMinute: number;
  };
  recentErrors: ErrorItem[];
}

export interface History {
  range: string;
  stepSeconds: number;
  network: {
    t: string;
    workersOnline: number;
    workersOffline: number;
    cpuCores: number;
    ramMb: number;
    gpus: number;
    vramMb: number;
    jobsQueued: number;
    jobsRunning: number;
    completedPerMin: number;
    failedPerMin: number;
    queueWaitP50S: number | null;
    queueWaitP95S: number | null;
  }[];
  api: { t: string; requestsPerMin: number; errors5xxPerMin: number; errors4xxPerMin: number; latencyP50Ms: number | null; latencyP95Ms: number | null }[];
}

export interface WorkerRow {
  id: string;
  name: string;
  status: string;
  state: string;
  online: boolean;
  agentVersion: string | null;
  lastSeenAt: string | null;
  heartbeatAgeS: number | null;
  uptimeS: number | null;
  hardware: { cpu: string | null; cores: number | null; threads: number | null; ramMb: number | null; gpus: { name: string; vendor: string | null; vramMb: number | null }[]; os: string | null };
  capacity: { cpuCores: number; ramMb: number; gpuPercent: number; vramMb: number; diskMb: number; maxTemperatureC: number } | null;
  usage: { cpuPercent: number | null; ghostCpuPercent: number | null; ramUsedMb: number | null; ramGhostMb: number | null; gpuPercent: number | null; temperatureC: number | null };
  performance: { verified: boolean; overall: number | null; cpu: number | null; gpu: number | null; inferenceItemsPerSec: number | null; latencyMs: number | null; calibratedAt: string | null } | null;
  activeJobs: number;
  last24h: { completed: number; failed: number };
}

export interface WorkerDetail {
  worker: WorkerRow;
  raw: Record<string, unknown>;
  profile: Record<string, any> | null;
  observed: Record<string, { itemsPerSec: number; samples: number; updatedAt: string }>;
  calibrations: { id: string; reason: string; status: string; requestedAt: string; completedAt: string | null; issues: string[]; error: string | null }[];
  history: {
    stepSeconds: number;
    points: {
      t: string;
      cpuPercent: number | null;
      ghostCpuPercent: number | null;
      ramUsedMb: number | null;
      ramGhostMb: number | null;
      gpuPercent: number | null;
      temperatureC: number | null;
      temperatureMaxC: number | null;
      activeJobs: number;
      sharingFraction: number;
    }[];
  };
  assignments: { id: string; jobId: string; jobName: string | null; type: string; attempt: number; status: string; assignedAt: string; startedAt: string | null; finishedAt: string | null; durationS: number | null; error: string | null; score: number }[];
  decisions: { jobId: string; score: number; summary: string; at: string }[];
  events: { id: number; jobId: string; type: string; payload: unknown; at: string }[];
}
