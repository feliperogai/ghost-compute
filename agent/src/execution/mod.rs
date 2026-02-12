//! Workload execution — **not implemented in this phase**.
//!
//! Planned: WebAssembly modules (Wasmtime) in an AppContainer inside a Job Object
//! with hard CPU/RAM caps. The agent never runs shell commands or native binaries
//! supplied by the server. Until this module exists the policy reports `waiting`,
//! the agent declares no workload types (so the scheduler sends nothing) and any
//! assignment that still arrives is declined.

/// Whether this build can run workloads.
pub const AVAILABLE: bool = false;

/// Workload types declared to the scheduler (see control-plane `scheduler/catalog.ts`).
pub const SUPPORTED_WORKLOAD_TYPES: &[&str] = &[];
