//! Agent side of the sandbox process: spawn, confine, feed, supervise, destroy.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
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
        let mut cmd = Command::new(&self.exe);
        cmd.env_clear()
            .current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // Needed by the CRT/loader; nothing else from the agent's environment.
            if let Some(root) = std::env::var_os("SystemRoot") {
                cmd.env("SystemRoot", root);
            }
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            let mem = limits.process_memory_bytes;
            let cpu_secs = limits.deadline.as_secs() + 5;
            // GPU drivers (Mesa) back device memory with memfds, which RLIMIT_FSIZE also
            // caps; allow those up to the memory limit and turn the on-disk shader cache off.
            let fsize = if input.gpu == GpuMode::Off { 0 } else { mem };
            if input.gpu != GpuMode::Off {
                cmd.env("MESA_SHADER_CACHE_DISABLE", "true");
            }
            unsafe {
                cmd.pre_exec(move || unix::confine(mem, cpu_secs, fsize));
            }
        }

        let mut child = cmd.spawn().map_err(|e| SandboxError::Spawn(e.to_string()))?;

        // Windows: confine BEFORE sending the request; the sandbox does nothing until it reads it.
        #[cfg(windows)]
        let job = {
            let job = windows::JobObject::new(limits.process_memory_bytes, limits.cpu_percent)
                .map_err(|e| SandboxError::Spawn(format!("job object: {e}")))?;
            let h = child.raw_handle().ok_or_else(|| SandboxError::Spawn("no process handle".into()))?;
            job.assign(h).map_err(|e| SandboxError::Spawn(format!("assign job object: {e}")))?;
            job
        };

        let req = Request {
            workload: workload.clone(),
            memory_bytes: limits.wasm_memory_bytes,
            deadline_ms: limits.deadline.as_millis() as u64,
            inputs: input.inputs,
            gpu: input.gpu,
        };
        let mut line = serde_json::to_vec(&req).map_err(|e| SandboxError::Protocol(e.to_string()))?;
        line.push(b'\n');
        let mut stdin = child.stdin.take().expect("piped stdin");
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

        let stdout = child.stdout.take().expect("piped stdout");
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
        #[cfg(windows)]
        job.terminate();
        let _ = child.start_kill();
        let status = child.wait().await.ok();
        match (&outcome, status) {
            (Err(SandboxError::Crashed(_)), Some(s)) => Err(SandboxError::Crashed(s.to_string())),
            _ => outcome,
        }
    }
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

#[cfg(windows)]
mod windows {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::System::Threading::IDLE_PRIORITY_CLASS;

    /// Job Object: memory cap, CPU hard cap, one process, killed when the handle closes.
    pub struct JobObject(HANDLE);

    // HANDLE is a kernel handle; safe to move between threads.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        /// Fails closed: if any limit cannot be applied, no job object is returned and nothing runs.
        pub fn new(memory_bytes: u64, cpu_percent: u32) -> Result<Self, String> {
            let step = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
            unsafe {
                let h = CreateJobObjectW(None, None).map_err(step("create"))?;
                let job = JobObject(h);
                let mut ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                    | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
                ext.BasicLimitInformation.ActiveProcessLimit = 1;
                ext.BasicLimitInformation.PriorityClass = IDLE_PRIORITY_CLASS.0;
                ext.ProcessMemoryLimit = memory_bytes as usize;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &ext as *const _ as *const _,
                    std::mem::size_of_val(&ext) as u32,
                )
                .map_err(step("memory/process limits"))?;

                let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                    ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    // Units of 1/100 of a percent of the whole machine.
                    Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: cpu_percent.clamp(1, 100) * 100 },
                };
                SetInformationJobObject(
                    h,
                    JobObjectCpuRateControlInformation,
                    &cpu as *const _ as *const _,
                    std::mem::size_of_val(&cpu) as u32,
                )
                .map_err(step("CPU hard cap"))?;

                let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                    UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                        | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                        | JOB_OBJECT_UILIMIT_EXITWINDOWS
                        | JOB_OBJECT_UILIMIT_GLOBALATOMS
                        | JOB_OBJECT_UILIMIT_HANDLES
                        | JOB_OBJECT_UILIMIT_READCLIPBOARD
                        | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                        | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
                };
                SetInformationJobObject(
                    h,
                    JobObjectBasicUIRestrictions,
                    &ui as *const _ as *const _,
                    std::mem::size_of_val(&ui) as u32,
                )
                .map_err(step("UI restrictions"))?;
                Ok(job)
            }
        }

        pub fn assign(&self, process: std::os::windows::io::RawHandle) -> windows::core::Result<()> {
            unsafe { AssignProcessToJobObject(self.0, HANDLE(process as _)) }
        }

        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE: closing the last handle kills anything left inside.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
