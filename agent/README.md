# ghost-agent

Worker agent for Windows, written in Rust. It detects hardware, monitors resource use,
applies the owner's limits and talks to the control plane over HTTPS.

**Done:** hardware detection, monitoring, heartbeat, secure communication, local IPC
for the desktop app, and **isolated execution** of registered workloads (see
[ADR 003](../docs/adr/003-isolated-execution.md)).
Also done: Windows service mode and the installer ([installer/windows](../installer/windows/README.md)).
**Next:** AppContainer for the sandbox process, self-update.

## Execution

Only built-in workload types run: `benchmark` and `image-inference` ([ADR 004](../docs/adr/004-image-inference.md)). A job carries a type and strictly
validated parameters, never code. Each job runs in a fresh `ghost-sandbox` process
(empty environment, private temp dir, Job Object / rlimits) hosting Wasmtime with no
WASI; the module is embedded in the binary and pinned by SHA-256. `ghost-sandbox` must
sit next to `ghost-agent`; without it execution is disabled and no types are declared.
Rebuild modules with `../workloads/build.sh` (prints the new hash to pin).
`image-inference` streams verified images into the sandbox, runs the dense layers on a GPU
(wgpu, our fixed shader; cargo feature `gpu`, on by default) when the owner shares one, and
resumes from server checkpoints. Until execution exists the agent reports `waiting` and
declines any offer, so no task is ever held by it.

## Use

```powershell
ghost-agent hardware                      # inventory as JSON
ghost-agent sample --count 5              # live samples as JSON lines
ghost-agent --config agent.toml enroll    # ghe_ code or ghu_ account token, from stdin
ghost-agent --config agent.toml run       # console; Ctrl+C stops
ghost-agent service                       # as the Windows service GhostWorker (installer)
ghost-agent --config agent.toml configure --server-url https://…   # installer: writes agent.toml
ghost-agent --config agent.toml uninstall-cleanup                   # uninstaller: leave + delete data
ghost-agent --config agent.toml status        # what the desktop app sees (JSON)
ghost-agent --config agent.toml control start # start | pause | stop
```

A fresh install starts **stopped**: nothing is shared until the owner starts it.
The choice (`control.json`) and limits edited in the desktop app (`limits.json`) persist in the data directory.

Config: see [`agent.example.toml`](agent.example.toml). Default path `%ProgramData%\ghost\agent.toml`.

`run` and `service` behave the same:
- **Not connected yet:** the agent waits. The local IPC answers only `hello` and `enroll` (desktop app "Conectar"); everything else returns `NOT_ENROLLED`.
- **Installer code:** a code left by the installer in `enroll.ini` is used once and deleted.
- **Revoked or rejected credentials:** the credentials are deleted, and the agent goes back to waiting instead of exiting.

## Modules

| Module | Responsibility |
|---|---|
| `hardware` | CPU model/cores/threads/ISA features, RAM, GPUs + dedicated VRAM (DXGI), volumes, OS |
| `monitoring` | CPU (total vs. ghost's own process tree), RAM, GPU utilisation + memory (PDH `GPU Engine`), temperature, input idle time, battery; 30 s smoothing window |
| `scheduler` | Policy engine: owner controls, schedule, battery, temperature, owner CPU/RAM, idle, locked-only, full-screen games, priority apps, cool-down → `waiting / available / running / paused / stopped` + `preempt` |
| `runtime` | Shared state read by the desktop app: connection, decision, stats, presence, workloads |
| `ipc` | Local IPC server (named pipe, see `../ipc`): `status`, `control`, `settings.get/set`, `presence.report` |
| `networking` | HTTPS client, token refresh, retries with jittered backoff, heartbeat loop |
| `security` | TLS policy + CA pinning, device identity, DPAPI-protected credentials, `SecretString` |
| `configuration` | `agent.toml`, strict validation, conservative defaults |
| `logging` | Console + daily-rotated JSON files (7 kept) |
| `execution` | Workload registry, Wasmtime runner, sandbox process supervisor, executor |
| `updater` | Placeholder for the next phase |

## Security

- **TLS:** rustls (no OpenSSL), TLS 1.2/1.3. With `ca_cert` only that CA is trusted; otherwise the bundled Mozilla roots. Plain HTTP is refused except loopback with an explicit flag.
- **No redirects:** a token can never be replayed to another host.
- **Identity:** random UUID per install (`identity.json`). No hardware serials or MachineGuid are sent.
- **Credentials:** the worker secret is encrypted with DPAPI (machine scope) on Windows; `0600` file elsewhere. It is only ever sent to `/v1/workers/auth`, which returns a short-lived token (refreshed before expiry, re-issued once on 401).
- **Revocation:** a `WORKER_REVOKED` answer stops the agent and deletes its credentials.
- **Logs:** secrets are wrapped in `SecretString` (`[REDACTED]` in any output). The e2e script checks the logs for leaks.
- **No command execution.** The agent has no code path that runs shell commands or server-supplied binaries.

## Calibration

When the control plane asks (first join, new hardware or agent, profile older than 7 days), the agent
benchmarks itself while idle and sharing: CPU, inference (CPU/GPU), GPU matmul, storage, latency
and bandwidth. CPU/inference/GPU tests run in the sandbox; the server only picks bounded sizes
([ADR 005](../docs/adr/005-worker-calibration.md)).

## Tests

```bash
cargo test                        # unit + integration tests (GPU path uses any Vulkan adapter, e.g. Mesa lavapipe)
./scripts/e2e-local.sh            # real control plane + real binary (needs Postgres/Redis)
```

Integration tests cover the API client (auth, token reuse, 401 re-auth, revocation, transient errors, redirects) against a mock server, the heartbeat loop (usage payload, declined offers, immediate pause report, final `stopped`, backoff), and **real TLS handshakes** (pinned CA accepted, other CA and default roots rejected).

Windows: CI runs the suite on `windows-latest`. Locally the crate cross-compiles with `--target x86_64-pc-windows-gnu`. The Windows build's network/TLS/DPAPI tests also pass under Wine.

## Known limits

- **CPU temperature** on Windows comes from WMI thermal zones (via sysinfo), which many desktops do not expose. It is then `None` and the temperature rule is skipped. GPU temperature needs NVML/ADLX (planned).
- **Idle time:** a service in session 0 cannot see the user's input, so it treats idle time as unknown. The tray app reports it over IPC. While nobody reports it, sharing waits (`presence_unknown`); it never assumes the owner is away.
- GPU utilisation relies on the `GPU Engine` performance counters (Windows 10 1709+).
