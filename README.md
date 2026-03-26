# ghost

Plataforma de computação distribuída em **rede privada**: computadores Windows emprestam CPU e GPU ociosas para executar workloads registrados, isolados em sandbox e sob os limites definidos pelo dono de cada máquina.

## Componentes

| Pasta | O que é | Stack |
|---|---|---|
| [`control-plane/`](control-plane/) | API REST + WebSocket, autenticação, jobs e scheduler | TypeScript, Fastify, PostgreSQL, Redis |
| [`agent/`](agent/) | Worker para Windows: hardware, monitoramento, política do dono, heartbeat, execução isolada | Rust, Wasmtime |
| [`desktop/`](desktop/) | App do dono do computador: estado, controles e configurações | Tauri 2, React |
| [`dashboard/`](dashboard/) | Painel web da rede: métricas, histórico, workers, erros (servido em `/dashboard/`) | React, Vite, SVG |
| [`ipc/`](ipc/) | Protocolo local entre app e agente (named pipe / Unix socket) | Rust |
| [`workloads/`](workloads/) | Workloads embutidos no agente (WebAssembly): `benchmark` e `image-inference` | Rust → wasm32 |
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
- **Escolha explicável.** `score = performance + availability + reliability + resource_fit − latency − current_load`, determinístico, pesos por prioridade; cada alocação registra "Worker X foi escolhido porque..." ([ADR 006](docs/adr/006-explainable-scoring.md)).
- **Escolha por desempenho medido.** Cada worker é calibrado ao entrar (CPU, GPU, VRAM, RAM, latência, banda, disco) e o scheduler usa esse perfil e o throughput real, não só "tem GPU" ([ADR 005](docs/adr/005-worker-calibration.md)).

## Workloads

| Tipo | O que faz | Onde roda |
|---|---|---|
| `benchmark` | Hash, primos, produto de matrizes | WASM, CPU |
| `image-inference` | Classifica um dataset de imagens PNG/JPEG em lotes paralelos, com retry, timeout, checkpoint e progresso ([ADR 004](docs/adr/004-image-inference.md)) | Decodificação em WASM; camadas densas em CPU ou GPU (NVIDIA preferida) |

```bash
# Inferência: dataset → lotes → workers → resultado combinado
curl -X POST $API/v1/datasets -d '{"name":"digits"}'                              # → id
curl -X POST "$API/v1/datasets/$ID/images?name=a.png" -H 'content-type: image/png' --data-binary @a.png
curl -X POST $API/v1/datasets/$ID/seal
curl -X POST $API/v1/inference -d '{"datasetId":"'$ID'","batchSize":32,"accelerator":"auto"}'  # → run
curl $API/v1/inference/$RUN            # status e progresso
curl $API/v1/inference/$RUN/result     # rótulo, confiança e top-k por imagem
```

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
