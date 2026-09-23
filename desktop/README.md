# ghost desktop

Tray app + window that shows the owner exactly what the ghost agent is doing on
this computer, and lets them start, pause or stop sharing and edit the limits.

Tauri 2 (Rust) + React/TypeScript. It holds no credentials and never talks to the
server: everything goes through the agent's local IPC endpoint
(`\\.\pipe\ghost-agent`, local interactive users only).

```
React UI ──invoke──▶ Tauri commands ──ghost-ipc──▶ agent (service)
                     tray menu        ◀── status ──
                     presence (idle / locked / full-screen) every 6 s ──▶
```

## What it shows

- **Headline:** one sentence with the current state and the reason ("Aguardando: você está usando a CPU: 45% (limite 30%)"). A running workload gets an accent frame, a pulsing mark and a band with the job, module, stage, elapsed time and progress.
- **Resources:** CPU, GPU, RAM, VRAM and temperature. Each bar stacks **ghost's use first**, then yours, and a tick marks the limit you set, so ghost's share compares directly with its limit.
- **Credits** (internal, 1 credit = 1 minute of completed work, no monetary value), jobs active / completed / failed, recent history, and the connection to the server.
- **When the agent is down:** a full-screen explanation that nothing runs without it, or a banner over the last known state.

## Controls and settings

`Iniciar compartilhamento` · `Pausar` · `Parar`, in the window and in the tray menu.
A fresh install is **stopped** until the owner starts it, and the choice survives reboots.

Settings are validated and persisted by the agent (`limits.json`):
CPU / GPU / RAM / temperature caps, allowed schedule, only when idle (minutes),
only when locked, pause on battery, pause during games (full-screen D3D / presentation,
via `SHQueryUserNotificationState`), pause while priority apps run, plus advanced thresholds.

## Develop

```bash
npm ci
npm run dev                            # browser + mock agent: http://localhost:1420/?scenario=running
npm test                               # component + text tests (vitest, jsdom)
npm run build && node scripts/screenshots.mjs   # every scenario, light/dark, narrow
npx tauri dev                          # real app; talks to a running agent
cd src-tauri && cargo test             # IPC link (reconnect, errors), tray text, presence
./scripts/e2e-desktop.sh out.png       # control plane + agent + real window on Xvfb
```

Mock scenarios: `stopped`, `waiting`, `ready`, `running`, `paused`, `hot`, `reconnecting`, `noagent`.
The mock starts from `src/fixtures/status.agent.json`, a status captured from a real
agent (`FIXTURE_OUT=… agent/scripts/e2e-local.sh`), so the UI is tested against the actual contract.

## Build for Windows

`npx tauri build` on Windows produces MSI and NSIS installers (WebView2 required, present on Windows 10/11).
From Linux, `cargo build --target x86_64-pc-windows-gnu` in `src-tauri` checks and links the Windows binary.
