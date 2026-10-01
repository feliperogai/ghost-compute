//! Windows: the sandbox runs in an AppContainer with no capabilities, inside a Job
//! Object. Checked on the live sandbox process (its token), then by what a process in
//! the same isolation can and cannot do: its own run directory yes; the user's files,
//! the network (not even loopback) no. Each "no" has a control showing it is the
//! isolation, not the test, that says no.
#![cfg(windows)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ghost_agent::execution::isolation::{self, JobObject};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    EqualSid, GetTokenInformation, TOKEN_APPCONTAINER_INFORMATION, TOKEN_GROUPS, TOKEN_QUERY, TokenAppContainerSid,
    TokenCapabilities, TokenIsAppContainer,
};
use windows::Win32::System::Threading::OpenProcessToken;

const EXE: &str = env!("CARGO_BIN_EXE_ghost-sandbox");

fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(exe)
}

/// A run directory, granted to the sandbox like the agent does for each run.
fn run_dir() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    isolation::grant(d.path(), isolation::RUN_DIR_ACCESS, true).unwrap();
    d
}

/// Runs `exe args` in the sandbox isolation; returns (stdout + stderr text, exit code).
fn run_isolated(exe: &Path, args: &[&str], cwd: &Path) -> (String, u32) {
    let job = JobObject::new(1 << 30, 100).unwrap();
    let p = isolation::spawn(exe, args, cwd, &job).unwrap();
    drop(p.stdin);
    let mut out = Vec::new();
    let mut stdout = p.stdout;
    stdout.read_to_end(&mut out).unwrap();
    (String::from_utf8_lossy(&out).into_owned(), p.process.wait_blocking())
}

/// A token information block, in an 8-byte aligned buffer (it holds pointers and SIDs).
fn token_info(token: HANDLE, class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Vec<u64> {
    let mut len = 0u32;
    unsafe {
        let _ = GetTokenInformation(token, class, None, 0, &mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        GetTokenInformation(token, class, Some(buf.as_mut_ptr() as *mut _), (buf.len() * 8) as u32, &mut len).unwrap();
        buf
    }
}

#[test]
fn the_sandbox_process_is_an_appcontainer_with_no_capabilities() {
    isolation::allow_running(Path::new(EXE));
    let dir = run_dir();
    let job = JobObject::new(1 << 30, 50).unwrap();
    let p = isolation::spawn(Path::new(EXE), &[], dir.path(), &job).unwrap();
    // It waits for its request: look at it meanwhile.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(HANDLE(p.process.raw_handle()), TOKEN_QUERY, &mut token).unwrap();
        let is_ac = token_info(token, TokenIsAppContainer);
        assert_eq!(*(is_ac.as_ptr() as *const u32), 1, "not an AppContainer");
        // No capability at all: no internetClient, no privateNetwork, no file libraries.
        let caps = token_info(token, TokenCapabilities);
        assert_eq!((*(caps.as_ptr() as *const TOKEN_GROUPS)).GroupCount, 0, "has capabilities");
        let sid = token_info(token, TokenAppContainerSid);
        let sid = (*(sid.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION)).TokenAppContainer;
        assert!(EqualSid(sid, isolation::appcontainer_sid().unwrap()).is_ok(), "unexpected package identity");
        let _ = CloseHandle(token);
    }
    drop(p.stdin); // no request: it exits on its own
    let code = p.process.wait_blocking();
    assert_eq!(code, 2, "sandbox should refuse an empty request (NO_REQUEST)");
}

#[test]
fn the_isolation_keeps_the_users_files_out_and_its_own_run_directory_in() {
    let dir = run_dir();
    std::fs::write(dir.path().join("own.txt"), "own-data").unwrap();
    let private = tempfile::tempdir().unwrap(); // the user's files: never granted
    let secret = private.path().join("secret.txt");
    std::fs::write(&secret, "user-secret").unwrap();
    let cmd = system32("cmd.exe");

    let (out, code) = run_isolated(&cmd, &["/c", "type", "own.txt"], dir.path());
    assert_eq!((code, out.contains("own-data")), (0, true), "control: {out}");

    let (out, code) = run_isolated(&cmd, &["/c", "type", &secret.to_string_lossy()], dir.path());
    assert_ne!(code, 0, "read the user's file: {out}");
    assert!(!out.contains("user-secret"), "{out}");
}

#[test]
fn the_isolation_has_no_network_not_even_loopback() {
    let dir = run_dir();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
    let curl = system32("curl.exe");

    let (out, code) = run_isolated(&curl, &["--stderr", "-", "-sS", "-m", "5", &url], dir.path());
    assert!(out.contains("curl:"), "curl did not run in the isolation: exit {code}, {out}");
    assert!(matches!(code, 7 | 28), "curl exit {code}: {out}");
    assert!(listener.accept().is_err(), "a connection from the sandbox reached the listener");

    // Control: the same request from outside does connect.
    let _ = std::process::Command::new(&curl).args(["-s", "-m", "2", &url]).output();
    std::thread::sleep(Duration::from_millis(200));
    assert!(listener.accept().is_ok(), "control: curl outside the sandbox could not connect");
}
