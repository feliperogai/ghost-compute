//! Agent side of the sandbox process: spawn, confine, feed, supervise, destroy.

use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::inference::{InferenceItem, encode_frame};
use super::protocol::{Event, GpuMode, MAX_LINE, Request};
use super::registry::Workload;

/// What the sandbox reports while it runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    Progress(f32),
    Item(InferenceItem),
}

/// Extra input for workloads that consume data (image-inference).
#[derive(Default)]
pub struct Input {
    /// Indexes announced in the request; frames must arrive in this order.
    pub inputs: Vec<u32>,
    /// Image bytes, fed to the sandbox as they arrive (bounded channel = bounded memory).
    pub frames: Option<tokio::sync::mpsc::Receiver<(u32, Vec<u8>)>>,
    pub gpu: GpuMode,
}

#[derive(Debug, Clone, Copy)]
pub struct SandboxLimits {
    /// WebAssembly linear memory cap.
    pub wasm_memory_bytes: usize,
    /// Whole-process cap (runtime + JIT + wasm memory).
    pub process_memory_bytes: u64,
    /// CPU hard cap as % of the whole machine (Windows Job Object).
    pub cpu_percent: u32,
    /// Wall-clock limit. The sandbox stops itself at this point; the agent kills it shortly after.
    pub deadline: Duration,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SandboxError {
    #[error("could not start sandbox: {0}")]
    Spawn(String),
    #[error("cancelled: {0}")]
    Cancelled(String),
    #[error("time limit exceeded")]
    Deadline,
    #[error("workload error {code}: {message}")]
    Workload { code: String, message: String },
    #[error("sandbox crashed or was killed by the OS ({0})")]
    Crashed(String),
    #[error("protocol violation: {0}")]
    Protocol(String),
}

impl SandboxError {
    /// Environment problems can be retried on another machine; bad jobs cannot.
    pub fn retryable(&self) -> bool {
        !matches!(self, SandboxError::Workload { code, .. } if code == "REJECTED" || code == "TRAP" || code == "LIMIT")
            && !matches!(self, SandboxError::Deadline)
    }
}

pub struct Sandbox {
    exe: PathBuf,
    work_root: PathBuf,
}

/// Grace period after the deadline before the agent kills the process itself.
const KILL_GRACE: Duration = Duration::from_secs(2);
const MAX_STDOUT: u64 = 4 * 1024 * 1024;

impl Sandbox {
    pub fn new(exe: PathBuf, work_root: PathBuf) -> Self {
        Self { exe, work_root }
    }

    /// Private directory the sandboxes (and the calibration scratch file) live in.
    pub fn work_root(&self) -> &Path {
        &self.work_root
    }

    /// How this platform isolates the sandbox (for logs and the self-test report).
    pub const ISOLATION: &'static str = if cfg!(windows) {
        "AppContainer (sem rede, sem arquivos do usuário) + Job Object"
    } else {
        "seccomp + rlimits"
    };

    /// A short built-in workload, isolated exactly as a job is: proves this computer can
    /// run work before it accepts any. Returns the workload's output.
    pub async fn self_test(&self) -> Result<serde_json::Value, SandboxError> {
        use super::registry::{BenchmarkKind, BenchmarkParams};
        let primes =
            Workload::Benchmark(BenchmarkParams { kind: BenchmarkKind::Primes, size: 1000, iterations: 3, seed: 1 });
        let limits = SandboxLimits {
            wasm_memory_bytes: 64 << 20,
            process_memory_bytes: 1 << 30,
            cpu_percent: 50,
            deadline: Duration::from_secs(30),
        };
        let out = self.run(&primes, limits, |_| {}, CancellationToken::new()).await?;
        // 168 primes up to 1000.
        if out["checksum"] != "00000000000000a8" {
            return Err(SandboxError::Protocol(format!("self-test: unexpected result {out}")));
        }
        Ok(out)
    }

    /// `ghost-sandbox(.exe)` next to the running agent.
    pub fn default_exe() -> PathBuf {
        let name = if cfg!(windows) { "ghost-sandbox.exe" } else { "ghost-sandbox" };
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(name))).unwrap_or_else(|| name.into())
    }

    pub async fn run(
        &self,
        workload: &Workload,
        limits: SandboxLimits,
        mut progress: impl FnMut(f32),
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, SandboxError> {
        let on = move |u: Update| {
            if let Update::Progress(f) = u {
                progress(f)
            }
        };
        self.run_with(workload, limits, Input::default(), on, cancel).await
    }

    pub async fn run_with(
        &self,
        workload: &Workload,
        limits: SandboxLimits,
        input: Input,
        mut on: impl FnMut(Update),
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, SandboxError> {
        let dir = self.work_root.join(uuid::Uuid::new_v4().to_string());
        create_private_dir(&dir).map_err(|e| SandboxError::Spawn(e.to_string()))?;
        let res = self.run_in(&dir, workload, limits, input, &mut on, cancel).await;
        // Destroy the environment whatever happened.
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(error = %e, dir = %dir.display(), "could not remove sandbox directory");
        }
        res
    }

    async fn run_in(
        &self,
        dir: &Path,
        workload: &Workload,
        limits: SandboxLimits,
        input: Input,
        on: &mut impl FnMut(Update),
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, SandboxError> {
        let Started { mut stdin, stdout, child } = spawn(&self.exe, dir, &limits, input.gpu)?;

        let req = Request {
            workload: workload.clone(),
            memory_bytes: limits.wasm_memory_bytes,
            deadline_ms: limits.deadline.as_millis() as u64,
            inputs: input.inputs,
            gpu: input.gpu,
        };
        let mut line = serde_json::to_vec(&req).map_err(|e| SandboxError::Protocol(e.to_string()))?;
        line.push(b'\n');
        // Writer runs alongside the reader: frames are streamed while results come back.
        // If the OS already killed the sandbox (e.g. memory cap) writes fail with a broken
        // pipe; the read loop below then sees EOF and reports the crash with its exit status.
        let mut frames = input.frames;
        let writer = tokio::spawn(async move {
            if let Err(e) = stdin.write_all(&line).await {
                tracing::debug!(error = %e, "could not write sandbox request");
                return;
            }
            if let Some(rx) = frames.as_mut() {
                while let Some((index, bytes)) = rx.recv().await {
                    if stdin.write_all(&encode_frame(index, &bytes)).await.is_err() {
                        return;
                    }
                }
            }
            let _ = stdin.flush().await;
        });
        let _writer_guard = AbortOnDrop(writer);

        // Bounded total output: a runaway sandbox cannot exhaust agent memory.
        let mut lines = BufReader::new(stdout.take(MAX_STDOUT)).lines();
        let deadline = tokio::time::sleep(limits.deadline + KILL_GRACE);
        tokio::pin!(deadline);

        let outcome = loop {
            tokio::select! {
                _ = cancel.cancelled() => break Err(SandboxError::Cancelled("stopped by agent".into())),
                _ = &mut deadline => break Err(SandboxError::Deadline),
                line = lines.next_line() => match line {
                    Ok(Some(l)) if l.len() > MAX_LINE => break Err(SandboxError::Protocol("line too long".into())),
                    Ok(Some(l)) => match serde_json::from_str::<Event>(&l) {
                        Ok(Event::Progress { fraction }) => on(Update::Progress(fraction.clamp(0.0, 1.0))),
                        Ok(Event::Item { item }) => on(Update::Item(item)),
                        Ok(Event::Done { output }) => break Ok(output),
                        Ok(Event::Error { code, message }) if code == "DEADLINE" => {
                            let _ = message;
                            break Err(SandboxError::Deadline);
                        }
                        Ok(Event::Error { code, message }) => break Err(SandboxError::Workload { code, message }),
                        Err(e) => break Err(SandboxError::Protocol(e.to_string())),
                    },
                    Ok(None) => break Err(SandboxError::Crashed("exited without a result".into())),
                    Err(e) => break Err(SandboxError::Protocol(e.to_string())),
                }
            }
        };

        // Destroy: kill whatever is still running, then reap.
        let status = child.kill_and_wait().await;
        match (&outcome, status) {
            (Err(SandboxError::Crashed(_)), Some(s)) => Err(SandboxError::Crashed(s)),
            _ => outcome,
        }
    }
}

/// A sandbox process that was started confined: its pipes and its lifetime.
struct Started {
    stdin: Box<dyn AsyncWrite + Unpin + Send>,
    stdout: Box<dyn AsyncRead + Unpin + Send>,
    child: Child,
}

#[cfg(unix)]
struct Child(tokio::process::Child);

#[cfg(unix)]
impl Child {
    async fn kill_and_wait(mut self) -> Option<String> {
        let _ = self.0.start_kill();
        self.0.wait().await.ok().map(|s| s.to_string())
    }
}

#[cfg(unix)]
fn spawn(exe: &Path, dir: &Path, limits: &SandboxLimits, gpu: GpuMode) -> Result<Started, SandboxError> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.env_clear()
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mem = limits.process_memory_bytes;
    let cpu_secs = limits.deadline.as_secs() + 5;
    // GPU drivers (Mesa) back device memory with memfds, which RLIMIT_FSIZE also caps;
    // allow those up to the memory limit and turn the on-disk shader cache off.
    let fsize = if gpu == GpuMode::Off { 0 } else { mem };
    if gpu != GpuMode::Off {
        cmd.env("MESA_SHADER_CACHE_DISABLE", "true");
    }
    unsafe {
        cmd.pre_exec(move || unix::confine(mem, cpu_secs, fsize));
    }
    let mut child = cmd.spawn().map_err(|e| SandboxError::Spawn(e.to_string()))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    Ok(Started { stdin: Box::new(stdin), stdout: Box::new(stdout), child: Child(child) })
}

/// Windows: in an AppContainer (no network, no user files) inside a Job Object (memory,
/// CPU, one process), both in place before its first instruction.
#[cfg(windows)]
struct Child {
    process: super::isolation::Process,
    // Dropping it (e.g. the run is abandoned) kills the process: KILL_ON_JOB_CLOSE.
    job: super::isolation::JobObject,
}

#[cfg(windows)]
impl Child {
    async fn kill_and_wait(self) -> Option<String> {
        self.job.terminate();
        self.process.terminate();
        let p = self.process.clone();
        tokio::task::spawn_blocking(move || p.wait_blocking()).await.ok().map(|code| format!("exit code: {code}"))
    }
}

#[cfg(windows)]
fn spawn(exe: &Path, dir: &Path, limits: &SandboxLimits, _gpu: GpuMode) -> Result<Started, SandboxError> {
    use super::isolation;
    let job = isolation::JobObject::new(limits.process_memory_bytes, limits.cpu_percent)
        .map_err(|e| SandboxError::Spawn(format!("job object: {e}")))?;
    isolation::allow_running(exe);
    // Its own run directory is the only place it may touch.
    isolation::grant(dir, isolation::RUN_DIR_ACCESS, true).map_err(SandboxError::Spawn)?;
    let p = isolation::spawn(exe, &[], dir, &job).map_err(SandboxError::Spawn)?;
    Ok(Started {
        stdin: Box::new(tokio::fs::File::from_std(p.stdin)),
        stdout: Box::new(tokio::fs::File::from_std(p.stdout)),
        child: Child { process: p.process, job },
    })
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

#[cfg(unix)]
mod unix {
    /// Runs in the child between fork and exec: only async-signal-safe calls.
    pub fn confine(mem_bytes: u64, cpu_secs: u64, fsize: u64) -> std::io::Result<()> {
        unsafe {
            let set = |res, v: u64| {
                let lim = libc::rlimit { rlim_cur: v as libc::rlim_t, rlim_max: v as libc::rlim_t };
                if libc::setrlimit(res, &lim) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            };
            set(libc::RLIMIT_AS, mem_bytes)?;
            set(libc::RLIMIT_CPU, cpu_secs)?;
            set(libc::RLIMIT_CORE, 0)?;
            // Cannot write files of any size (stdout is a pipe, unaffected); GPU mode: see caller.
            set(libc::RLIMIT_FSIZE, fsize)?;
            set(libc::RLIMIT_NOFILE, 32)?;
            // No privilege gain through setuid binaries; own session, detached from the terminal.
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::setsid();
        }
        Ok(())
    }
}
