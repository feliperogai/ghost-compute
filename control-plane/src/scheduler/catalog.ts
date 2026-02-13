// Workload types registered in the system. A job declares one; a worker declares
// which it can run. A type names a built-in sandboxed module, never a command:
// there is no "shell", "script" or "executable" type, and no way to upload code.

export interface WorkloadType {
  id: string;
  description: string;
  /** Jobs of this type always need a GPU. */
  requiresGpu: boolean;
  /** Whether jobs of this type may request a GPU at all. */
  supportsGpu: boolean;
}

export const WORKLOAD_TYPES: readonly WorkloadType[] = [
  {
    id: 'benchmark',
    description: 'Deterministic CPU benchmark (hash chain, prime sieve, matrix product) in a WebAssembly sandbox',
    requiresGpu: false,
    supportsGpu: false,
  },
];

export const workloadType = (id: string) => WORKLOAD_TYPES.find((t) => t.id === id);
