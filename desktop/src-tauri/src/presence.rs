//! User-session signals the agent (a service in session 0) cannot observe itself.

use ghost_ipc::PresenceReport;

#[cfg(windows)]
pub fn collect() -> PresenceReport {
    PresenceReport { idle_secs: win::idle_secs(), locked: Some(win::locked()), fullscreen_app: win::fullscreen_app() }
}

/// Non-Windows builds are for development only: nothing to report.
#[cfg(not(windows))]
pub fn collect() -> PresenceReport {
    PresenceReport::default()
}

#[cfg(windows)]
mod win {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP,
    };
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };

    pub fn idle_secs() -> Option<u64> {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if !GetLastInputInfo(&mut info).as_bool() {
                return None;
            }
            Some(u64::from(GetTickCount().wrapping_sub(info.dwTime)) / 1000)
        }
    }

    /// While the session is locked the input desktop is Winlogon's secure desktop,
    /// which a normal user process cannot open.
    pub fn locked() -> bool {
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) } {
            Ok(h) => {
                unsafe {
                    let _ = CloseDesktop(h);
                }
                false
            }
            Err(_) => true,
        }
    }

    /// Full-screen game / Direct3D app / presentation, as the Shell reports it for
    /// "do not disturb" decisions.
    pub fn fullscreen_app() -> Option<bool> {
        let state = unsafe { SHQueryUserNotificationState() }.ok()?;
        Some(state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_BUSY || state == QUNS_PRESENTATION_MODE)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn collect_never_panics() {
        let p = super::collect();
        if let Some(i) = p.idle_secs {
            assert!(i < 60 * 60 * 24 * 60);
        }
    }
}
