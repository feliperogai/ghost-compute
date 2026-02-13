//! Isolated workload execution.
//!
//! Layers, outermost first:
//! 1. **Registry** (`registry`): only built-in workload types; the job supplies
//!    strictly validated parameters, never code, paths, URLs or commands.
//! 2. **Sandbox process** (`sandbox`, `bin/ghost-sandbox.rs`): a separate, short-lived
//!    process per job with a scrubbed environment, an empty private working directory,
//!    no inherited handles except stdin/stdout, and OS limits (Windows Job Object:
//!    CPU hard cap, memory cap, one process, kill-on-close; Unix: rlimits, no_new_privs).
//! 3. **WebAssembly** (`wasm`): Wasmtime with no WASI; the module can only compute and
//!    call `ghost.progress`. Memory, stack and time are bounded.
//!
//! The agent never runs shell commands, scripts or executables received from the network.

pub mod executor;
pub use executor::Executor;
pub mod protocol;
pub mod registry;
pub mod sandbox;
pub mod wasm;

/// Whether this build can run workloads.
pub const AVAILABLE: bool = true;

/// Workload types declared to the scheduler (see control-plane `scheduler/catalog.ts`).
pub const SUPPORTED_WORKLOAD_TYPES: &[&str] = registry::TYPES;
