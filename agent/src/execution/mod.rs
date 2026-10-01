//! Isolated workload execution.
//!
//! Layers, outermost first:
//! 1. **Registry** (`registry`): only built-in workload types; the job supplies
//!    strictly validated parameters, never code, paths, URLs or commands.
//! 2. **Sandbox process** (`sandbox`, `bin/ghost-sandbox.rs`): a separate, short-lived
//!    process per job with a scrubbed environment, an empty private working directory,
//!    no inherited handles except stdin/stdout, and OS limits (Windows: AppContainer
//!    with no capabilities — no network, no user files — inside a Job Object with CPU
//!    hard cap, memory cap, one process, kill-on-close; Unix: rlimits, no_new_privs).
//! 3. **WebAssembly** (`wasm`): Wasmtime with no WASI; the module can only compute and
//!    call `ghost.progress`. Memory, stack and time are bounded.
//!
//! 4. **GPU** (`gpu`, optional): for `image-inference` only, the dense layers run in our
//!    own fixed WGSL shader, inside the sandbox process, on vectors the WebAssembly
//!    preprocessor produced. Job data never reaches the GPU as code.
//!
//! The agent never runs shell commands, scripts or executables received from the network.

pub mod executor;
pub use executor::Executor;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod inference;
#[cfg(windows)]
pub mod isolation;
pub mod protocol;
pub mod registry;
pub mod sandbox;
pub mod wasm;

/// Whether this build can run workloads.
pub const AVAILABLE: bool = true;

/// Workload types declared to the scheduler (see control-plane `scheduler/catalog.ts`).
pub const SUPPORTED_WORKLOAD_TYPES: &[&str] = registry::TYPES;
