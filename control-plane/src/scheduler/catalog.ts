// Known workload types. A job declares one; a worker declares which it can run.
// A type names a sandboxed runtime, never a command: there is no "shell" type.

export interface WorkloadType {
  id: string;
  description: string;
  /** Jobs of this type always need a GPU. */
  requiresGpu: boolean;
}

export const WORKLOAD_TYPES: readonly WorkloadType[] = [
  { id: 'wasm-cpu', description: 'Signed WebAssembly module, CPU only (Wasmtime sandbox)', requiresGpu: false },
  { id: 'wasm-gpu', description: 'Signed WebAssembly module with mediated GPU compute', requiresGpu: true },
];

export const workloadType = (id: string) => WORKLOAD_TYPES.find((t) => t.id === id);
