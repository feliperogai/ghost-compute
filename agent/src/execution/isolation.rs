//! Windows isolation of the sandbox process: an AppContainer inside a Job Object.
//!
//! - AppContainer (`ghost.sandbox`, no capabilities): the process runs at low integrity
//!   with its own package identity. It has no network at all (not even loopback), and
//!   can open only what is granted to it or to every app: its private run directory,
//!   System32, Program Files. Not the user's files, not `ProgramData\ghost`.
//! - Job Object: memory and CPU caps, one process, UI limits, killed with the job.
//!
//! The process is created suspended, put in the Job Object, then resumed: it runs no
//! instruction outside its limits. It inherits exactly its three standard handles.
//! Fails closed: if any step cannot be done, nothing runs.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, HLOCAL, LocalFree,
    SetHandleInformation,
};
use windows::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, GetSecurityInfo, SE_FILE_OBJECT, SE_WINDOW_OBJECT,
    SetEntriesInAclW, SetNamedSecurityInfoW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
use windows::Win32::Security::{
    ACE_FLAGS, ACL, DACL_SECURITY_INFORMATION, FreeSid, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ALL_ACCESS, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};
use windows::Win32::System::JobObjects::*;
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, CloseWindowStation, DESKTOP_CONTROL_FLAGS, GetProcessWindowStation, GetThreadDesktop,
    GetUserObjectInformationW, OpenDesktopW, OpenWindowStationW, UOI_NAME,
};
use windows::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentThreadId, GetExitCodeProcess, IDLE_PRIORITY_CLASS, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR, w};

/// The sandbox's package identity. Its SID is derived from this name.
pub const APPCONTAINER_NAME: &str = "ghost.sandbox";

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

fn owned(h: HANDLE) -> OwnedHandle {
    // SAFETY: `h` is a valid handle we own (just created) and nothing else closes it.
    unsafe { OwnedHandle::from_raw_handle(h.0) }
}

/// The AppContainer SID (`S-1-15-2-…`), derived once per process.
pub fn appcontainer_sid() -> Result<PSID, String> {
    // A PSID is a pointer; kept as an address so it can live in a static. Never freed.
    static SID: OnceLock<Result<usize, String>> = OnceLock::new();
    SID.get_or_init(|| unsafe {
        // Registering the profile is best effort: the SID is what isolates, and it is
        // derived from the name whether or not a profile exists (a service account may
        // have no profile to register it in).
        match CreateAppContainerProfile(
            w!("ghost.sandbox"),
            w!("ghost sandbox"),
            w!("Runs ghost workloads with no network and no access to your files"),
            None,
        ) {
            Ok(sid) => {
                FreeSid(sid);
            }
            Err(e) if e.code() == ERROR_ALREADY_EXISTS.to_hresult() => {}
            Err(e) => tracing::debug!(error = %e, "AppContainer profile not registered; using the derived SID"),
        }
        DeriveAppContainerSidFromAppContainerName(&windows::core::HSTRING::from(APPCONTAINER_NAME))
            .map(|sid| sid.0 as usize)
            .map_err(|e| format!("AppContainer SID: {e}"))
    })
    .clone()
    .map(|a| PSID(a as *mut core::ffi::c_void))
}

/// `old` plus an entry allowing the AppContainer `access` (inherited by what is inside
/// when `inherit`). The caller frees the result with LocalFree.
unsafe fn with_appcontainer_entry(old: *const ACL, access: u32, inherit: bool) -> Result<*mut ACL, String> {
    let sid = appcontainer_sid()?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: if inherit { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { ACE_FLAGS(NO_INHERITANCE.0) },
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: PWSTR(sid.0 as *mut u16),
            ..Default::default()
        },
    };
    let mut new: *mut ACL = std::ptr::null_mut();
    let r = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old), &mut new) };
    if r != ERROR_SUCCESS { Err(format!("build ACL: {r:?}")) } else { Ok(new) }
}

/// Grants the sandbox's AppContainer `access` to `path` (inherited by what is inside when
/// `inherit`). Needs WRITE_DAC on `path` (owner or administrator).
pub fn grant(path: &Path, access: u32, inherit: bool) -> Result<(), String> {
    let name = wide(path);
    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let mut old: *mut ACL = std::ptr::null_mut();
        let r = GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old),
            None,
            &mut sd,
        );
        if r != ERROR_SUCCESS {
            return Err(format!("read ACL of {}: {r:?}", path.display()));
        }
        let result = with_appcontainer_entry(old, access, inherit).and_then(|new| {
            let r = SetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new),
                None,
            );
            LocalFree(Some(HLOCAL(new as _)));
            if r == ERROR_SUCCESS { Ok(()) } else { Err(format!("write ACL of {}: {r:?}", path.display())) }
        });
        LocalFree(Some(HLOCAL(sd.0)));
        result
    }
}

/// Same as `grant`, for an open window station or desktop (`handle` with READ_CONTROL and WRITE_DAC).
unsafe fn grant_window_object(handle: HANDLE, access: u32) -> Result<(), String> {
    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let mut old: *mut ACL = std::ptr::null_mut();
        let r = GetSecurityInfo(
            handle,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old),
            None,
            Some(&mut sd),
        );
        if r != ERROR_SUCCESS {
            return Err(format!("read ACL: {r:?}"));
        }
        let result = with_appcontainer_entry(old, access, false).and_then(|new| {
            let r = SetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(new), None);
            LocalFree(Some(HLOCAL(new as _)));
            if r == ERROR_SUCCESS { Ok(()) } else { Err(format!("write ACL: {r:?}")) }
        });
        LocalFree(Some(HLOCAL(sd.0)));
        result
    }
}

fn object_name(handle: HANDLE) -> Result<String, String> {
    let mut buf = [0u16; 256];
    unsafe {
        GetUserObjectInformationW(handle, UOI_NAME, Some(buf.as_mut_ptr() as *mut _), (buf.len() * 2) as u32, None)
            .map_err(|e| format!("object name: {e}"))?;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Ok(String::from_utf16_lossy(&buf[..len]))
}

// Window station: enumerate desktops, read attributes, global atoms (the Job Object still
// refuses atoms and foreign USER handles), read its security. Desktop: read objects,
// create windows (graphics stacks may make hidden ones), enumerate, read its security.
const WINSTA_USE: u32 = 0x0001 | 0x0002 | 0x0020 | 0x0100 | 0x0002_0000;
const DESKTOP_USE: u32 = 0x0001 | 0x0002 | 0x0040 | 0x0002_0000;

/// A service runs on its own, non-interactive window station, which an AppContainer
/// cannot open: user32 (loaded by the graphics stack) then fails to start the process
/// (0xC0000142). Lets the sandbox's AppContainer use the agent's own window station and
/// desktop, where no windows live. The interactive one (WinSta0) already admits apps
/// and is left alone. Once per run.
fn allow_window_station() -> Result<(), String> {
    static DONE: OnceLock<Result<(), String>> = OnceLock::new();
    DONE.get_or_init(|| unsafe {
        let station = GetProcessWindowStation().map_err(|e| format!("window station: {e}"))?;
        let name = object_name(HANDLE(station.0))?;
        if name.eq_ignore_ascii_case("WinSta0") {
            return Ok(());
        }
        let rights = (READ_CONTROL | WRITE_DAC).0;
        let station = OpenWindowStationW(PCWSTR(wide(&name).as_ptr()), false, rights)
            .map_err(|e| format!("open window station {name}: {e}"))?;
        let r = grant_window_object(HANDLE(station.0), WINSTA_USE);
        let _ = CloseWindowStation(station);
        r.map_err(|e| format!("window station {name}: {e}"))?;

        // A worker thread may not be on a desktop yet; a service station's desktop is "Default".
        let dname = GetThreadDesktop(GetCurrentThreadId())
            .ok()
            .and_then(|d| object_name(HANDLE(d.0)).ok())
            .unwrap_or_else(|| "Default".into());
        let desktop = OpenDesktopW(PCWSTR(wide(&dname).as_ptr()), DESKTOP_CONTROL_FLAGS(0), false, rights)
            .map_err(|e| format!("open desktop {dname}: {e}"))?;
        let r = grant_window_object(HANDLE(desktop.0), DESKTOP_USE);
        let _ = CloseDesktop(desktop);
        r.map_err(|e| format!("desktop {name}\\{dname}: {e}"))?;
        tracing::info!(window_station = %name, desktop = %dname, "sandbox may use the service's window station");
        Ok(())
    })
    .clone()
}

/// Lets the AppContainer read and run the sandbox binary where it is not readable by
/// every app already (an installed agent is: Program Files is). The binary links the C
/// runtime statically, so it needs no DLL of its own. Only this file: an inheritable
/// grant on its folder would rewrite the ACL of everything below it (a build folder
/// holds thousands of files). Best effort, once per run: without WRITE_DAC nothing changes.
pub fn allow_running(exe: &Path) {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        if let Err(e) = grant(exe, (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE).0, false) {
            tracing::debug!(error = %e, "sandbox binary ACL unchanged (expected for an installed agent)");
        }
    });
}

/// A started, isolated process.
pub struct Isolated {
    /// Its standard input (write end).
    pub stdin: std::fs::File,
    /// Its standard output (read end).
    pub stdout: std::fs::File,
    pub process: Process,
}

/// The process handle, shared with whoever waits on it (the handle outlives the wait).
#[derive(Clone)]
pub struct Process(Arc<OwnedHandle>);

impl Process {
    pub fn raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0.as_raw_handle()
    }

    pub fn terminate(&self) {
        unsafe {
            let _ = TerminateProcess(HANDLE(self.raw_handle()), 1);
        }
    }

    /// Blocks until the process ends; returns its exit code.
    pub fn wait_blocking(&self) -> u32 {
        let mut code = 0u32;
        unsafe {
            WaitForSingleObject(HANDLE(self.raw_handle()), INFINITE);
            let _ = GetExitCodeProcess(HANDLE(self.raw_handle()), &mut code);
        }
        code
    }
}

/// The child's whole environment: `SystemRoot` (CRT, loader) and the profile paths
/// Windows reads to give an AppContainer its own TEMP and LOCALAPPDATA (process creation
/// fails without LOCALAPPDATA). Nothing else from the agent's environment.
fn environment() -> Vec<u16> {
    let get = |name: &str| std::env::var_os(name);
    let root = get("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let profile = get("USERPROFILE");
    let local = get("LOCALAPPDATA")
        .or_else(|| profile.as_ref().map(|p| Path::new(p).join("AppData").join("Local").into_os_string()))
        .unwrap_or_else(|| Path::new(&root).join("Temp").into_os_string());
    let mut vars: Vec<(&str, std::ffi::OsString)> = vec![("SystemRoot", root), ("LOCALAPPDATA", local)];
    for name in ["USERPROFILE", "APPDATA", "TEMP", "TMP"] {
        if let Some(v) = get(name) {
            vars.push((name, v));
        }
    }
    // Sorted by name, case-insensitively, as Windows expects of an environment block.
    vars.sort_by_key(|(n, _)| n.to_ascii_uppercase());
    let mut block = Vec::new();
    for (name, value) in vars {
        block.extend(OsStr::new(name).encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.into();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// Starts `exe` (with `args`) in the AppContainer, inside `job`, in `cwd`, with an empty
/// environment except `SystemRoot`. Its stderr goes nowhere.
pub fn spawn(exe: &Path, args: &[&str], cwd: &Path, job: &JobObject) -> Result<Isolated, String> {
    let sid = appcontainer_sid()?;
    allow_window_station()?;
    let step = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
    unsafe {
        // Pipes: the child's ends are inheritable, ours are not.
        let inheritable = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        let (mut in_r, mut in_w, mut out_r, mut out_w) =
            (HANDLE::default(), HANDLE::default(), HANDLE::default(), HANDLE::default());
        CreatePipe(&mut in_r, &mut in_w, Some(&inheritable), 0).map_err(step("stdin pipe"))?;
        let (child_in, our_in) = (owned(in_r), owned(in_w));
        CreatePipe(&mut out_r, &mut out_w, Some(&inheritable), 0).map_err(step("stdout pipe"))?;
        let (our_out, child_out) = (owned(out_r), owned(out_w));
        for ours in [&our_in, &our_out] {
            SetHandleInformation(HANDLE(ours.as_raw_handle()), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
                .map_err(step("pipe inheritance"))?;
        }
        let null = owned(
            CreateFileW(
                w!("NUL"),
                FILE_GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                Some(&inheritable),
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
            .map_err(step("NUL"))?,
        );

        // Attributes: the AppContainer (no capabilities) and the only handles to inherit.
        let mut size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
        let mut buf = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr() as _);
        InitializeProcThreadAttributeList(Some(list), 2, None, &mut size).map_err(step("attribute list"))?;
        struct ListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
        impl Drop for ListGuard {
            fn drop(&mut self) {
                unsafe { DeleteProcThreadAttributeList(self.0) };
            }
        }
        let _list_guard = ListGuard(list);
        let caps = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: std::ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&caps as *const _ as *const _),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(step("AppContainer attribute"))?;
        let handles =
            [HANDLE(child_in.as_raw_handle()), HANDLE(child_out.as_raw_handle()), HANDLE(null.as_raw_handle())];
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_ptr() as *const _),
            std::mem::size_of_val(&handles),
            None,
            None,
        )
        .map_err(step("handle list"))?;

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = handles[0];
        si.StartupInfo.hStdOutput = handles[1];
        si.StartupInfo.hStdError = handles[2];
        si.lpAttributeList = list;

        let exe_w = wide(exe);
        let mut cmdline: Vec<u16> = wide(
            std::iter::once(quote(&exe.to_string_lossy()))
                .chain(args.iter().map(|a| quote(a)))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let cwd_w = wide(cwd);
        let env = environment();

        let mut pi = PROCESS_INFORMATION::default();
        CreateProcessW(
            PCWSTR(exe_w.as_ptr()),
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
            Some(env.as_ptr() as *const _),
            PCWSTR(cwd_w.as_ptr()),
            &si.StartupInfo,
            &mut pi,
        )
        .map_err(step("create process in AppContainer"))?;
        let process = Process(Arc::new(owned(pi.hProcess)));
        let thread = owned(pi.hThread);
        // Limits before the first instruction; if they cannot be applied, it never runs.
        if let Err(e) = job.assign(process.raw_handle()) {
            process.terminate();
            return Err(format!("assign job object: {e}"));
        }
        if ResumeThread(HANDLE(thread.as_raw_handle())) == u32::MAX {
            process.terminate();
            return Err(format!("resume: {}", windows::core::Error::from_thread()));
        }
        drop((thread, child_in, child_out, null));
        Ok(Isolated { stdin: std::fs::File::from(our_in), stdout: std::fs::File::from(our_out), process })
    }
}

/// The access a run directory gives its own sandbox.
pub const RUN_DIR_ACCESS: u32 = FILE_ALL_ACCESS.0;

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
