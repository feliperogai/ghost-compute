//! Self-confinement of the `ghost-sandbox` process, applied before it reads its request.
//!
//! The workload is WebAssembly with no host imports, so it cannot reach the file system
//! or the network by itself. These controls are the next wall, for the case where a bug
//! in the runtime (or a GPU driver) lets it run native code:
//!
//! - Linux: seccomp filter (with `no_new_privs`, set by the agent before exec): no new
//!   programs, no internet/raw sockets, no debugging other processes, no kernel
//!   facilities a workload never needs (modules, mounts, namespaces, BPF, keyrings…).
//!   Everything else keeps working, including the GPU driver.
//! - Windows: process mitigation policies: no child processes, no DLLs from remote or
//!   low-integrity locations, no legacy extension points (AppInit DLLs, hooks), strict
//!   handle checks, side-channel isolation where the OS supports it. The Job Object set
//!   by the agent (memory, CPU, one process, UI limits) stays in force.

use std::io;

/// Applies the confinement to the current process. Irreversible.
pub fn confine_sandbox() -> io::Result<()> {
    imp::confine()
}

#[cfg(target_os = "linux")]
pub mod imp {
    use std::io;

    // Classic BPF, as used by seccomp.
    const BPF_LD_W_ABS: u16 = 0x20; // BPF_LD (0) | BPF_W (0) | BPF_ABS (0x20)
    const BPF_JMP_JEQ_K: u16 = 0x15; // BPF_JMP (5) | BPF_JEQ (0x10) | BPF_K (0)
    const BPF_JMP_JGE_K: u16 = 0x35; // BPF_JMP (5) | BPF_JGE (0x30) | BPF_K (0)
    const BPF_RET_K: u16 = 0x06; // BPF_RET (6) | BPF_K (0)

    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
    const SECCOMP_FILTER_FLAG_TSYNC: libc::c_ulong = 1;

    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64

    // struct seccomp_data { int nr; __u32 arch; __u64 ip; __u64 args[6]; }
    const OFF_NR: u32 = 0;
    const OFF_ARCH: u32 = 4;
    const OFF_ARG0_LO: u32 = 16; // little-endian: low half of args[0]

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: libc::c_ushort,
        filter: *const SockFilter,
    }

    const fn stmt(code: u16, k: u32) -> SockFilter {
        SockFilter { code, jt: 0, jf: 0, k }
    }
    const fn jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
        SockFilter { code, jt, jf, k }
    }

    /// Syscalls a workload never needs; they fail with EPERM.
    pub const DENIED: &[libc::c_long] = &[
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_kexec_load,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_acct,
        libc::SYS_quotactl,
        libc::SYS_userfaultfd,
        libc::SYS_name_to_handle_at,
        libc::SYS_open_by_handle_at,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ];

    /// The filter program. Public for inspection in tests.
    fn program() -> Vec<SockFilter> {
        let eperm = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let eacces = SECCOMP_RET_ERRNO | libc::EACCES as u32;
        let mut p = vec![
            // Only the native ABI: anything else (e.g. 32-bit entry points) kills the process.
            stmt(BPF_LD_W_ABS, OFF_ARCH),
            jump(BPF_JMP_JEQ_K, AUDIT_ARCH, 1, 0),
            stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
            stmt(BPF_LD_W_ABS, OFF_NR),
        ];
        #[cfg(target_arch = "x86_64")]
        {
            // x32 syscalls (nr | 0x40000000) would slip past the numbers below.
            p.push(jump(BPF_JMP_JGE_K, 0x4000_0000, 0, 1));
            p.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
        }
        for &nr in DENIED {
            p.push(jump(BPF_JMP_JEQ_K, nr as u32, 0, 1));
            p.push(stmt(BPF_RET_K, eperm));
        }
        // socket(): local (AF_UNIX) only — GPU drivers may use it; no IP, raw or netlink.
        p.push(jump(BPF_JMP_JEQ_K, libc::SYS_socket as u32, 0, 3));
        p.push(stmt(BPF_LD_W_ABS, OFF_ARG0_LO));
        p.push(jump(BPF_JMP_JEQ_K, libc::AF_UNIX as u32, 1, 0));
        p.push(stmt(BPF_RET_K, eacces));
        p.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
        p
    }

    pub fn confine() -> io::Result<()> {
        let prog = program();
        let fprog = SockFprog { len: prog.len() as libc::c_ushort, filter: prog.as_ptr() };
        unsafe {
            // Required for an unprivileged filter; the agent already set it, this is idempotent.
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // TSYNC: every thread of the process, not just this one.
            if libc::syscall(
                libc::SYS_seccomp,
                SECCOMP_SET_MODE_FILTER,
                SECCOMP_FILTER_FLAG_TSYNC,
                &fprog as *const SockFprog,
            ) != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Runs `f` in a forked child with the filter applied; returns the child's exit code.
        /// Only async-signal-safe calls happen in the child.
        fn in_confined_child(f: fn() -> i32) -> i32 {
            unsafe {
                let pid = libc::fork();
                assert!(pid >= 0, "fork failed");
                if pid == 0 {
                    let code = if confine().is_ok() { f() } else { 99 };
                    libc::_exit(code);
                }
                let mut status = 0;
                libc::waitpid(pid, &mut status, 0);
                assert!(libc::WIFEXITED(status), "child did not exit normally (status {status})");
                libc::WEXITSTATUS(status)
            }
        }

        fn errno() -> i32 {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
        }

        #[test]
        fn no_internet_or_raw_sockets() {
            let code = in_confined_child(|| unsafe {
                for family in [libc::AF_INET, libc::AF_INET6, libc::AF_PACKET, libc::AF_NETLINK] {
                    if libc::socket(family, libc::SOCK_STREAM, 0) != -1 || errno() != libc::EACCES {
                        return 1;
                    }
                }
                // Local sockets keep working (drivers).
                if libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) < 0 {
                    return 2;
                }
                0
            });
            assert_eq!(code, 0);
        }

        #[test]
        fn no_new_programs_no_debugging_no_namespaces() {
            let code = in_confined_child(|| unsafe {
                let path = b"/bin/true\0";
                let argv = [path.as_ptr() as *const libc::c_char, std::ptr::null()];
                let envp = [std::ptr::null::<libc::c_char>()];
                if libc::execve(path.as_ptr() as *const libc::c_char, argv.as_ptr(), envp.as_ptr()) != -1
                    || errno() != libc::EPERM
                {
                    return 1;
                }
                if libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) != -1 || errno() != libc::EPERM {
                    return 2;
                }
                if libc::unshare(libc::CLONE_NEWUSER) != -1 || errno() != libc::EPERM {
                    return 3;
                }
                if libc::syscall(libc::SYS_bpf, 0, 0, 0) != -1 || errno() != libc::EPERM {
                    return 4;
                }
                0
            });
            assert_eq!(code, 0);
        }

        #[test]
        fn ordinary_work_still_runs() {
            let code = in_confined_child(|| unsafe {
                // Memory, time, pipes and threads-related calls a runtime needs.
                let p = libc::mmap(
                    std::ptr::null_mut(),
                    1 << 20,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                );
                if p == libc::MAP_FAILED {
                    return 1;
                }
                let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
                if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) != 0 {
                    return 2;
                }
                let mut fds = [0; 2];
                if libc::pipe(fds.as_mut_ptr()) != 0 {
                    return 3;
                }
                0
            });
            assert_eq!(code, 0);
        }

        #[test]
        fn every_denied_call_is_in_the_program() {
            let prog = program();
            for &nr in DENIED {
                assert!(prog.iter().any(|i| i.code == BPF_JMP_JEQ_K && i.k == nr as u32), "missing syscall {nr}");
            }
            assert!(prog.len() < 4096);
        }
    }
}

#[cfg(windows)]
pub mod imp {
    use std::io;
    use windows::Win32::System::Threading::{
        PROCESS_MITIGATION_POLICY, ProcessChildProcessPolicy, ProcessExtensionPointDisablePolicy,
        ProcessFontDisablePolicy, ProcessImageLoadPolicy, ProcessSideChannelIsolationPolicy,
        ProcessStrictHandleCheckPolicy, SetProcessMitigationPolicy,
    };

    /// (policy, flags, required). Each policy structure is a single DWORD of flag bits.
    pub const POLICIES: &[(PROCESS_MITIGATION_POLICY, u32, bool)] = &[
        // DisableExtensionPoints: no AppInit DLLs, window hooks, IMEs injected into us.
        (ProcessExtensionPointDisablePolicy, 0b1, true),
        // NoRemoteImages | NoLowMandatoryLabelImages | PreferSystem32Images.
        (ProcessImageLoadPolicy, 0b111, true),
        // RaiseExceptionOnInvalidHandleReference | HandleExceptionsPermanentlyEnabled.
        (ProcessStrictHandleCheckPolicy, 0b11, true),
        // NoChildProcessCreation (Windows 10 1709+; the Job Object also allows one process).
        (ProcessChildProcessPolicy, 0b1, false),
        // DisableNonSystemFonts.
        (ProcessFontDisablePolicy, 0b1, false),
        // SmtBranchTargetIsolation | IsolateSecurityDomain | DisablePageCombine |
        // SpeculativeStoreBypassDisable (Windows 10 1809+).
        (ProcessSideChannelIsolationPolicy, 0b1111, false),
    ];

    pub fn confine() -> io::Result<()> {
        for &(policy, flags, required) in POLICIES {
            let r = unsafe { SetProcessMitigationPolicy(policy, &flags as *const u32 as *const core::ffi::c_void, 4) };
            if let (Err(e), true) = (r, required) {
                return Err(io::Error::other(format!("mitigation policy {}: {e}", policy.0)));
            }
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub mod imp {
    pub fn confine() -> std::io::Result<()> {
        // Other platforms rely on the wasm sandbox and rlimits only (not supported as workers).
        Ok(())
    }
}
