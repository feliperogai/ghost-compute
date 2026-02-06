# ghost-agent

Worker agent for Windows, written in Rust. It detects hardware, monitors resource use,
applies the owner's limits and talks to the control plane over HTTPS.

**This phase:** hardware detection, monitoring, heartbeat and secure communication.
Execution, owner IPC (pause/resume/stop from the tray), Windows service mode and
self-update come next. Until execution exists the agent reports `waiting` and
declines any offer, so no task is ever held by it.

## Use

```powershell
ghost-agent hardware                      # inventory as JSON
ghost-agent sample --count 5              # live samples as JSON lines
ghost-agent --config agent.toml enroll    # reads the ghe_ token from stdin
ghost-agent --config agent.toml run
```

Config: see [`agent.example.toml`](agent.example.toml). Default path `%ProgramData%\ghost\agent.toml`.

Exit codes of `run`: `0` shutdown · `2` credentials rejected (re-enroll) · `3` worker revoked (credentials deleted).

## Modules

| Module | Responsibility |
|---|---|
| `hardware` | CPU model/cores/threads/ISA features, RAM, GPUs + dedicated VRAM (DXGI), volumes, OS |
| `monitoring` | CPU (total vs. ghost's own process tree), RAM, GPU utilisation + memory (PDH `GPU Engine`), temperature, input idle time, battery; 30 s smoothing window |
| `scheduler` | Policy engine: owner controls, schedule, battery, temperature, owner CPU/RAM, idle, cool-down → `waiting / available / running / paused / stopped` + `preempt` |
| `networking` | HTTPS client, token refresh, retries with jittered backoff, heartbeat loop |
| `security` | TLS policy + CA pinning, device identity, DPAPI-protected credentials, `SecretString` |
| `configuration` | `agent.toml`, strict validation, conservative defaults |
| `logging` | Console + daily-rotated JSON files (7 kept) |
| `execution`, `updater` | Placeholders for the next phases |

## Security

- **TLS:** rustls (no OpenSSL), TLS 1.2/1.3. With `ca_cert` only that CA is trusted; otherwise the bundled Mozilla roots. Plain HTTP is refused except loopback with an explicit flag.
- **No redirects:** a token can never be replayed to another host.
- **Identity:** random UUID per install (`identity.json`). No hardware serials or MachineGuid are sent.
- **Credentials:** the worker secret is encrypted with DPAPI (machine scope) on Windows; `0600` file elsewhere. It is only ever sent to `/v1/workers/auth`, which returns a short-lived token (refreshed before expiry, re-issued once on 401).
- **Revocation:** a `WORKER_REVOKED` answer stops the agent and deletes its credentials.
- **Logs:** secrets are wrapped in `SecretString` (`[REDACTED]` in any output). The e2e script checks the logs for leaks.
- **No command execution.** The agent has no code path that runs shell commands or server-supplied binaries.

## Tests

```bash
cargo test                        # 53 unit + integration tests
./scripts/e2e-local.sh            # real control plane + real binary (needs Postgres/Redis)
```

Integration tests cover the API client (auth, token reuse, 401 re-auth, revocation, transient errors, redirects) against a mock server, the heartbeat loop (usage payload, declined offers, immediate pause report, final `stopped`, backoff), and **real TLS handshakes** (pinned CA accepted, other CA and default roots rejected).

Windows: CI runs the suite on `windows-latest`. Locally the crate cross-compiles with `--target x86_64-pc-windows-gnu`. The Windows build's network/TLS/DPAPI tests also pass under Wine.

## Known limits

- **CPU temperature** on Windows comes from WMI thermal zones (via sysinfo), which many desktops do not expose. It is then `None` and the temperature rule is skipped. GPU temperature needs NVML/ADLX (planned).
- **Idle time** from a service in session 0 is not the user's. The tray app will report it over IPC. Until then an unknown idle time does not block sharing.
- GPU utilisation relies on the `GPU Engine` performance counters (Windows 10 1709+).
