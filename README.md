# ghost

Plataforma de computação distribuída em **rede privada**: computadores Windows emprestam CPU ociosa para executar workloads registrados, isolados em sandbox e sob os limites definidos pelo dono de cada máquina.

## Componentes

| Pasta | O que é | Stack |
|---|---|---|
| [`control-plane/`](control-plane/) | API REST + WebSocket, autenticação, jobs e scheduler | TypeScript, Fastify, PostgreSQL, Redis |
| [`agent/`](agent/) | Worker para Windows: hardware, monitoramento, política do dono, heartbeat, execução isolada | Rust, Wasmtime |
| [`desktop/`](desktop/) | App do dono do computador: estado, controles e configurações | Tauri 2, React |
| [`ipc/`](ipc/) | Protocolo local entre app e agente (named pipe / Unix socket) | Rust |
| [`workloads/`](workloads/) | Workloads embutidos no agente (WebAssembly), hoje só `benchmark` | Rust → wasm32 |
| [`docs/`](docs/) | [Arquitetura](docs/ARCHITECTURE.md) e decisões ([ADRs](docs/adr/)) | — |

```
Operador ──REST──▶ control-plane ──(heartbeat, atribuições, HTTPS)──▶ agent ──▶ ghost-sandbox ──▶ Wasmtime ──▶ workload
                         ▲                                              ▲
                  Postgres + Redis                        desktop ──IPC local──┘
```

## Princípios

- **Nenhuma execução arbitrária.** Jobs só referenciam tipos registrados e carregam parâmetros validados; o código é embutido no agente e fixado por hash ([ADR 003](docs/adr/003-isolated-execution.md)).
- **O dono manda.** Compartilhamento começa desligado; pausar e parar são imediatos; limites de CPU, RAM, temperatura, horário, ociosidade, jogos e apps prioritários são locais e o servidor não os relaxa.
- **O servidor não confia no worker.** Resultados são verificados por hash; o scheduler revalida toda decisão e o banco impede sobrealocação.

## Rodando localmente

```bash
# Control Plane (precisa de Postgres e Redis)
cd control-plane && npm ci && npm run migrate && npm run create-admin -- admin@example.com && npm run dev

# Agente
cd agent && cargo build && ./target/debug/ghost-agent --config agent.toml enroll && ./target/debug/ghost-agent --config agent.toml run

# App desktop (fala com o agente em execução)
cd desktop && npm ci && npx tauri dev
```

Cada pasta tem seu README com detalhes, testes e scripts ponta a ponta (`agent/scripts/e2e-local.sh`, `desktop/scripts/e2e-desktop.sh`).

## Branches

Uma única branch: **`main`**.
