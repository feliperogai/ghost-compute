//! WebAssembly execution with Wasmtime, locked down:
//! - no WASI: the only import a module may have is `ghost.progress(f32)`;
//! - bounded memory, tables and instances; one memory, no threads;
//! - wall-clock deadline via epoch interruption (the guest cannot block it);
//! - bounded native stack.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, Trap};

#[derive(Debug, Clone, Copy)]
pub struct WasmLimits {
    pub memory_bytes: usize,
    pub deadline: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum WasmError {
    #[error("module rejected: {0}")]
    Rejected(String),
    #[error("deadline exceeded")]
    Deadline,
    #[error("resource limit exceeded: {0}")]
    Limit(String),
    #[error("workload trapped: {0}")]
    Trap(String),
}

struct State {
    limits: StoreLimits,
    progress: Box<dyn FnMut(f32) + Send>,
}

const EPOCH_TICK: Duration = Duration::from_millis(10);

fn engine() -> Result<Engine, WasmError> {
    let mut c = Config::new();
    c.epoch_interruption(true)
        .max_wasm_stack(512 * 1024)
        // Threads, GC and the component model are not compiled in (Cargo features).
        .wasm_multi_memory(false)
        .wasm_memory64(false)
        // Small reservations so an OS address-space limit on the sandbox process is workable.
        .memory_reservation(0)
        .memory_guard_size(64 * 1024)
        .memory_reservation_for_growth(1 << 20)
        .guard_before_linear_memory(false)
        .memory_may_move(true);
    Engine::new(&c).map_err(|e| WasmError::Rejected(e.to_string()))
}

/// Runs `run(kind, size, iterations, seed) -> i64` of `bytes`.
pub fn run(
    bytes: &[u8],
    args: (i32, i64, i64, i64),
    limits: WasmLimits,
    progress: impl FnMut(f32) + Send + 'static,
) -> Result<i64, WasmError> {
    let engine = engine()?;
    let module = Module::new(&engine, bytes).map_err(|e| WasmError::Rejected(e.to_string()))?;

    // Explicit allow-list check (Linker would also refuse, this gives a clearer error).
    for imp in module.imports() {
        if (imp.module(), imp.name()) != ("ghost", "progress") {
            return Err(WasmError::Rejected(format!("forbidden import {}::{}", imp.module(), imp.name())));
        }
    }

    let state = State {
        limits: StoreLimitsBuilder::new()
            .memory_size(limits.memory_bytes)
            .table_elements(10_000)
            .instances(1)
            .tables(1)
            .memories(1)
            .trap_on_grow_failure(true)
            .build(),
        progress: Box::new(progress),
    };
    let mut store = Store::new(&engine, state);
    store.limiter(|s| &mut s.limits);

    let ticks = (limits.deadline.as_millis() / EPOCH_TICK.as_millis()).max(1) as u64;
    store.set_epoch_deadline(ticks);
    store.epoch_deadline_trap();

    // Watchdog: advances the epoch; the guest traps once the deadline is reached.
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (engine, done) = (engine.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(EPOCH_TICK);
                engine.increment_epoch();
            }
        })
    };

    let mut linker: Linker<State> = Linker::new(&engine);
    linker
        .func_wrap("ghost", "progress", |mut c: wasmtime::Caller<'_, State>, f: f32| {
            if f.is_finite() {
                (c.data_mut().progress)(f.clamp(0.0, 1.0));
            }
        })
        .map_err(|e| WasmError::Rejected(e.to_string()))?;

    let started = Instant::now();
    let result = (|| {
        let instance = linker.instantiate(&mut store, &module).map_err(classify)?;
        let run = instance
            .get_typed_func::<(i32, i64, i64, i64), i64>(&mut store, "run")
            .map_err(|e| WasmError::Rejected(format!("missing or wrong `run` export: {e}")))?;
        run.call(&mut store, args).map_err(classify)
    })();
    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    tracing::debug!(elapsed_ms = started.elapsed().as_millis() as u64, ok = result.is_ok(), "wasm run finished");
    result
}

fn classify(e: wasmtime::Error) -> WasmError {
    match e.downcast_ref::<Trap>() {
        Some(Trap::Interrupt) => WasmError::Deadline,
        Some(Trap::StackOverflow) => WasmError::Limit("stack".into()),
        Some(Trap::MemoryOutOfBounds) => WasmError::Trap("memory out of bounds".into()),
        Some(t) => WasmError::Trap(t.to_string()),
        None => {
            let s = format!("{e:#}");
            if s.contains("limit") || s.contains("grow") { WasmError::Limit(s) } else { WasmError::Trap(s) }
        }
    }
}
