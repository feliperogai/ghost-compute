# ghost

Plataforma **aberta** de computação distribuída: provedores oferecem CPU e GPU ociosas de computadores Windows, com preço, horários e limites próprios; clientes enviam jobs de workloads registrados, com requisitos e orçamento. Tudo roda isolado em sandbox, sob os limites do dono de cada máquina, e é pago em créditos virtuais (sem dinheiro).

## Componentes

| Pasta | O que é | Stack |
|---|---|---|
| [`control-plane/`](control-plane/) | API REST + WebSocket, autenticação, jobs e scheduler | TypeScript, Fastify, PostgreSQL, Redis |
| [`agent/`](agent/) | Worker para Windows: hardware, monitoramento, política do dono, heartbeat, execução isolada | Rust, Wasmtime |
| [`desktop/`](desktop/) | App do dono do computador: estado, controles e configurações | Tauri 2, React |
| [`dashboard/`](dashboard/) | Painel web da rede: métricas, histórico, workers, erros (servido em `/dashboard/`) | React, Vite, SVG |
| [`installer/windows/`](installer/windows/) | Instalador do Worker: serviço, app, configuração segura, firewall, login, remoção limpa; explica tudo antes de instalar | WiX 5 (MSI + setup.exe) |
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
- **Resultados verificados.** Jobs públicos só concluem quando computadores de donos e redes diferentes concordam; auditoria de segurança com teste para cada controle em [docs/security/AUDIT.md](docs/security/AUDIT.md).
- **Matching justo e verificável.** Requisitos e capacidades são restrições rígidas; preço do provedor, orçamento do cliente e reputação entram no score. Reputação só com métricas observadas pelo servidor (jobs concluídos, taxa de falha, uptime, tempo de resposta), sem avaliações ([ADR 008](docs/adr/008-open-platform.md)).
- **Créditos virtuais, sem dinheiro.** Workers ganham por tempo × recursos × desempenho × disponibilidade; jobs reservam e pagam o tempo usado. Ledger de partidas dobradas, só inserção, saldo sempre derivado, cadeia de hashes verificável ([ADR 007](docs/adr/007-internal-credits.md)).
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

## Instalar um Worker no Windows (passo a passo)

Resumo: servidor no ar com HTTPS → código de conexão → instalador no PC → conferir → ligar o compartilhamento.
Detalhes do instalador (propriedades, modo silencioso, build): [installer/windows/README.md](installer/windows/README.md).

### 1. Servidor (control plane) no ar, com HTTPS

O Worker só conversa com `https://`. Sem isso o instalador recusa o endereço.

```bash
cd control-plane
export WORKER_TOKEN_SECRET=$(openssl rand -hex 32)   # guarde: trocar derruba os workers e a verificação em 2 etapas
export POSTGRES_PASSWORD=$(openssl rand -hex 16)     # guarde: vale só na criação do banco
docker compose up -d --build                        # Postgres + Redis + API na porta 8080
docker compose exec control-plane node dist/src/cli/create-admin.js voce@exemplo.com
# → "api token (shown once): ghu_..."  guarde este token
# → "expires: ..."  vale 90 dias (STAFF_TOKEN_TTL_DAYS); antes disso, crie o próximo com POST /v1/me/tokens
```

**Verificação em duas etapas (obrigatória para a equipe).** Abra `https://ghost.seudominio.com/dashboard/`, entre com o `ghu_...` e siga a tela: leia o QR code com um app autenticador (Google Authenticator, Microsoft Authenticator, Authy…) e digite o código. Até isso, a conta da equipe só acessa a própria página. Depois, ações que criam credenciais ou créditos (tokens, usuários, códigos de conexão, concessão de créditos) pedem o código atual do app no header `x-ghost-otp`. Perdeu o celular? No servidor: `docker compose exec control-plane node dist/src/cli/reset-mfa.js voce@exemplo.com`.

Coloque um proxy HTTPS na frente da porta 8080 (ex.: Caddy: `ghost.seudominio.com { reverse_proxy localhost:8080 }`).
Com proxy (um salto): `TRUST_PROXY=1 REQUIRE_TLS=true docker compose up -d`.

Teste: `curl https://ghost.seudominio.com/healthz` → `{"status":"ok"}`.

Postgres e Redis só aceitam conexões do próprio servidor (`127.0.0.1`). Para acessá-los de fora, use um túnel SSH.

### 2. Código de conexão do computador

Uso único, vale 1 hora por padrão. Um por computador.

```bash
curl -X POST https://ghost.seudominio.com/v1/provider/enrollment-tokens \
  -H "authorization: Bearer ghu_..." -H "x-ghost-otp: 123456" \
  -H 'content-type: application/json' -d '{"note":"PC da sala"}'
# → {"token":"ghe_...", "expiresAt": ...}     (x-ghost-otp: o código que o app autenticador mostra agora)
```

Pode pular: depois dá para conectar pelo app, colando o `ghu_...` (usado uma vez, nunca guardado). Contas com verificação em duas etapas (toda a equipe) usam o código `ghe_...`.

### 3. Baixar o instalador

GitHub → **Actions** → workflow **installer** → última execução verde em `main` → artefato **ghost-worker-installer**:

- `ghost-worker-setup-<versão>.exe`: para usar em casa. Instala o WebView2 se faltar.
- `ghost-worker-<versão>.msi`: para TI e instalação silenciosa.

Sem assinatura digital ainda: o SmartScreen avisa. Clique em *Mais informações › Executar assim mesmo*.

### 4. Instalar

Execute o `setup.exe` (pede administrador). Telas:

1. **Como o ghost funciona**: recursos usados, quando roda, como pausar e remover. Marque *Li e entendi*.
2. **Conectar**: endereço `https://ghost.seudominio.com` e o código `ghe_...` (opcional).
3. Opções: app ao iniciar o Windows (**deixe marcado**: sem ele o Worker não sabe se você está usando o PC e não compartilha), atalho, regra de firewall.
4. Concluir. O compartilhamento começa **desligado**.

### 5. Conferir se está funcionando

Abra o **PowerShell como administrador**:

| Verificação | Comando | Esperado |
|---|---|---|
| Serviço rodando | `Get-Service GhostWorker` | `Running` |
| Conta do serviço | `(Get-CimInstance Win32_Service -Filter "Name='GhostWorker'").StartName` | `NT SERVICE\GhostWorker` |
| Agente responde | `& "$env:ProgramFiles\ghost\ghost-agent.exe" status` | JSON com `workerId`. `NOT_ENROLLED` = ainda não conectado (passo 6) |
| Sandbox isolado | `& "$env:ProgramFiles\ghost\ghost-agent.exe" self-test` | `"ok": true`, isolamento `AppContainer (sem rede, sem arquivos do usuário) + Job Object` |
| Código consumido | `Test-Path $env:ProgramData\ghost\enroll.ini` | `False` |
| Configuração | `Get-Content $env:ProgramData\ghost\agent.toml` | `url = "https://ghost.seudominio.com"` |
| Firewall | `Get-NetFirewallRule -DisplayName 'ghost Worker: sandbox sem rede'` | Outbound, Block. Nenhuma porta aberta |
| Logs | `Get-ChildItem $env:ProgramData\ghost\logs` | Arquivos do dia |

No servidor, o computador aparece na sua conta:

```bash
curl https://ghost.seudominio.com/v1/provider/workers -H "authorization: Bearer ghu_..."
# → items[].status = "active"; state muda de "offline" para "stopped" / "waiting" / "available"
```

No PC: ícone do **ghost** perto do relógio. Abra o painel.

### 6. Conectar pelo app (se não usou código na instalação)

Painel → tela **Conectar** → cole `ghe_...` ou `ghu_...` (`ghu_` só para contas sem verificação em duas etapas). Conectar **não** liga o compartilhamento.

### 7. Ligar, pausar, parar

- Painel: **Iniciar compartilhamento**, **Pausar**, **Parar**. Efeito imediato.
- Terminal (admin): `& "$env:ProgramFiles\ghost\ghost-agent.exe" control start` (ou `pause`, `stop`).
- Limites (CPU, RAM, GPU, horários, ociosidade): painel › Configurações. A GPU vem **desligada** (`max_gpu_percent = 0`).

Estado "Aguardando" é normal: o Worker espera o PC ficar ocioso, dentro dos seus horários e limites.

### 8. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Instalador: "O endereço do servidor precisa começar com https://" | URL `http://` | Use HTTPS (passo 1). |
| `status` → `NOT_ENROLLED` e "inválido" | Código expirado ou já usado | Gere outro (passo 2) e conecte pelo app. |
| `status` → erro de conexão com o agente | Serviço parado | `Start-Service GhostWorker`; veja os logs. |
| Painel: "Não dá para saber se você está usando o computador" | App não está aberto na sessão | Abra o ghost (menu Iniciar). Ative o início com o Windows. |
| Computador `offline` no servidor | Rede, proxy ou certificado | Nos logs: erros de TLS/DNS. Teste `curl https://.../healthz` no próprio PC. |
| "Credenciais recusadas" / "removido da rede" | Computador revogado | Gere um código novo e conecte de novo. |

### 9. Remover

*Configurações › Aplicativos › ghost › Desinstalar* (ou menu Iniciar › *Desinstalar ghost*).
Avisa o servidor, remove serviço, arquivos, `C:\ProgramData\ghost`, regra de firewall, atalhos e registro.

Conferir: `Get-Service GhostWorker` dá erro; `Test-Path "$env:ProgramFiles\ghost", "$env:ProgramData\ghost"` → `False False`.

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
