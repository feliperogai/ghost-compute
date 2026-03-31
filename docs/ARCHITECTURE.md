# ghost — Arquitetura do MVP

> Status: proposta original (antes do código). Decisões que a alteraram estão em [`adr/`](adr/): stack do Control Plane (001), modelo de Job e scheduler (002), execução isolada (003).

---

## 0. Princípios

1. **Nenhum código arbitrário.** Worker só executa *módulos de workload* assinados e aprovados por admin.
2. **Dono da máquina manda.** Pausa local é imediata e não depende do servidor.
3. **Worker nunca aceita conexões de entrada.** Toda comunicação é iniciada pelo Worker (saída 443).
4. **Zero confiança no Worker.** Resultado é dado não confiável até ser validado.
5. **Limites aplicados em duas camadas:** política (agente decide parar) + kernel (Job Object impede exceder).
6. **Simplicidade operacional.** Poucos serviços, um banco, deploy único.

---

## 1. Visão geral

```
                         ┌──────────────────────────── Control Plane (Linux) ───────────────────────────┐
  Admin (browser) ──────►│  Dashboard (SPA)                                                              │
        HTTPS + OIDC     │      │ REST/JSON + SSE                                                        │
                         │      ▼                                                                        │
                         │  API Server ──────► PostgreSQL (estado, fila, auditoria)                     │
                         │      │   ▲                                                                    │
                         │      │   └── Scheduler (loop no mesmo binário, lock via Postgres)             │
                         │      │                                                                        │
                         │  Worker Gateway (gRPC bidi, mTLS)  ◄───── CA interna (emite certs curtos)     │
                         │      │                                                                        │
                         │  Object Store (S3/MinIO): módulos, inputs, outputs  (URLs pré-assinadas)      │
                         │  Observabilidade: OTel Collector → Prometheus / Loki / Tempo → Grafana        │
                         └──────┬────────────────────────────────────────────────────────────────────────┘
                                │ gRPC/HTTP2 sobre TLS 1.3 mTLS (saída do Worker, porta 443)
          ┌─────────────────────┴───────────────────── Máquina Windows ─────────────────────────┐
          │  ghost-agent (Windows Service, conta virtual sem privilégios)                         │
          │   ├─ Connector (gRPC)        ├─ Hardware Probe       ├─ Resource Monitor            │
          │   ├─ Policy Engine (limites) ├─ Task Runner          ├─ Artifact Cache (hash)       │
          │   └─ Local IPC (named pipe com ACL)                                                    │
          │        ▲                                   │ spawn                                     │
          │        │                                   ▼                                           │
          │  ghost-tray (sessão do usuário)     ghost-sandbox.exe (AppContainer + Job Object)      │
          │   Pausar / Parar / Limites / Status        └─ Wasmtime → módulo .wasm (WASI restrito)   │
          └───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Componentes e responsabilidades

### 2.1 Control Plane

| Componente | Responsabilidade |
|---|---|
| **API Server** | REST para Dashboard/CLI. CRUD de jobs, módulos, workers, políticas. AuthN/AuthZ de humanos. Emissão de tokens de enrollment. |
| **Worker Gateway** | Termina mTLS dos Workers. Mantém stream gRPC por Worker. Recebe heartbeats, telemetria, progresso, resultados. Entrega ofertas de tarefa e comandos (cancel, revoke). |
| **Scheduler** | Divide jobs em tasks. Faz matching task↔worker por capacidade declarada. Gerencia leases (TTL), retries, timeouts, reatribuição. |
| **Enrollment / CA** | Valida token de enrollment, assina CSR do Worker, renova certificados, mantém lista de revogação. |
| **Module Registry** | Armazena módulos WASM, manifestos, hashes, assinaturas. Só módulos `approved` são despacháveis. |
| **Result Validator** | Verifica hash/formato do output. Opcional: execução redundante (N workers) e comparação. |
| **Dashboard** | Estado de workers, jobs, tasks, logs, métricas. Ações administrativas. |
| **PostgreSQL** | Fonte única de verdade. Fila de tasks (`SELECT … FOR UPDATE SKIP LOCKED`). Auditoria. |
| **Object Store** | Blobs grandes. Worker baixa/sobe via URL pré-assinada de curta duração. |

No MVP: API Server + Gateway + Scheduler + CA = **um binário** (`ghost-server`) com módulos internos. Separar depois.

### 2.2 Worker (Windows)

| Componente | Responsabilidade |
|---|---|
| **ghost-agent** (Windows Service) | Processo central. Roda como `NT SERVICE\ghost-agent` (conta virtual, sem admin). |
| Connector | Stream gRPC, reconexão com backoff, renovação de cert. |
| Hardware Probe | Inventário: CPU (modelo, núcleos, AVX), RAM, GPUs (DXGI), SO, disco livre. |
| Resource Monitor | Amostra 1 Hz: CPU total, CPU do ghost, RAM, GPU, temperatura, input do usuário. |
| Policy Engine | Máquina de estados. Decide se pode aceitar/continuar/pausar/matar. **Autoridade local final.** |
| Task Runner | Baixa artefatos, verifica hash e assinatura, lança sandbox, coleta progresso, envia resultado. |
| Local IPC | Named pipe `\\.\pipe\ghost` com DACL: só usuário interativo local + SYSTEM. |
| **ghost-tray** | App na sessão do usuário. Botões Pausar/Retomar/Parar tudo. Edição de limites. Reporta `GetLastInputInfo` (idle) ao agente. |
| **ghost-sandbox.exe** | Host mínimo do Wasmtime. Roda em AppContainer sem capabilities, dentro de Job Object com limites rígidos. |

**Por que tray separado:** serviço não enxerga input do usuário (Session 0). Tray também dá o controle físico ao dono.

---

## 3. Isolamento (decisão central)

### Recomendação MVP: **WebAssembly (WASI) via Wasmtime + AppContainer + Job Object**

Camadas:

1. **WASM** — memória linear isolada, sem syscalls diretas. Imports WASI restritos: sem rede, sem sockets, FS só um diretório pré-aberto (`/work`) com input read-only e output write-only. Sem relógio de alta precisão (mitiga side-channel).
2. **Wasmtime limits** — `memory_limit`, `table_limit`, epoch interruption (preempção a cada ~10 ms), fuel opcional.
3. **AppContainer** — processo sem acesso a arquivos do usuário, registro, rede (`internetClient` ausente).
4. **Job Object** — `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`, `JobMemoryLimit`, `ActiveProcessLimit=1`, `KILL_ON_JOB_CLOSE`, prioridade `IDLE`.
5. **Restricted token + Low integrity** — defesa extra.

Módulos compilados de Rust/C/C++/Go(TinyGo)/Zig para `wasm32-wasip1`.

### Alternativas avaliadas

| Opção | Isolamento | GPU | Requisito | Veredito |
|---|---|---|---|---|
| WASM + AppContainer | Alto | Não | Nenhum | **MVP** |
| Windows Sandbox | Muito alto (VM) | vGPU limitada | Pro/Enterprise, virtualização | Fase 2 opcional |
| Hyper-V VM leve / Firecracker-like | Muito alto | GPU-PV complexo | Pro + Hyper-V | Fase 3 |
| WSL2 + containers | Médio-alto | CUDA via WSL | WSL2 instalado | Não: dependência pesada, kernel compartilhado entre distros |
| Processo nativo restrito | Baixo | Sim | — | **Proibido** |

### GPU

Fora do MVP de execução. MVP **detecta e monitora** GPU. Caminhos futuros:
- `wasi-gfx`/WebGPU mediado pelo host (host expõe apenas compute shaders validados).
- Hyper-V GPU-PV em VM dedicada.
Ambos exigem pesquisa; não bloqueiam o MVP.

---

## 4. Política de recursos (Worker)

### 4.1 Configuração do dono

```
enabled: bool
schedule: [{days: Mon-Fri, from: 22:00, to: 07:00}, ...]
require_idle_minutes: 5            # sem input do usuário
max_cpu_percent: 50                # teto do ghost
max_ram_mb: 4096
max_gpu_percent: 0                 # MVP
max_temp_c: 80                     # CPU package
user_cpu_threshold_percent: 30     # uso do dono acima disso → preempção
user_ram_threshold_percent: 70
on_battery: pause
```

Configuração vive **localmente** (fonte de verdade). Servidor recebe cópia para exibir e respeitar. Servidor pode sugerir políticas mais restritas, nunca mais permissivas.

### 4.2 Máquina de estados

```
          ┌──────────┐ usuário ativa  ┌───────────┐ condições OK   ┌───────────┐ lease   ┌─────────┐
 DISABLED │          ├──────────────► │ WAITING   ├──────────────► │ AVAILABLE ├───────► │ RUNNING │
          └──────────┘                └───────────┘ ◄──────────────┴───────────┘         └────┬────┘
               ▲                            ▲    condição violada                            │
               │ Parar                      │                                                │ limite violado
               │                            │ hysteresis ok                                  ▼
          ┌────┴─────┐   Pausar (tray)  ┌───┴───────┐   grace 0–5 s / kill    ┌────────────┐
          │ STOPPED  │ ◄─────────────── │ PAUSED    │ ◄─────────────────────── │ PREEMPTING │
          └──────────┘                  └───────────┘                          └────────────┘
```

Regras:
- **Pausar (tray):** suspende processo sandbox (`NtSuspendProcess` via Job) em < 100 ms; notifica servidor; se não retomar em N min, mata e devolve lease.
- **Parar tudo:** mata Job Object imediatamente (`TerminateJobObject`), fecha conexão, estado `STOPPED`.
- **Violação de limite** (uso do dono, temperatura, horário, bateria): `PREEMPTING` → checkpoint se o módulo suporta, senão kill. Retorna task ao servidor como `preempted` (não conta como falha).
- **Histerese:** condição precisa estar OK por X segundos (ex.: 60 s) antes de voltar a `AVAILABLE`. Evita oscilação.
- **Uso do dono** = uso total − uso da árvore do ghost. Medido por PDH (`\Processor(_Total)\% Processor Time`) e contadores do Job Object.
- **Watchdog:** se o agente travar, `KILL_ON_JOB_CLOSE` mata o sandbox.

### 4.3 Temperatura

Windows não expõe temperatura de CPU de forma confiável sem driver. Opções:
- WMI `MSAcpi_ThermalZoneTemperature` (frequentemente ausente/impreciso).
- LibreHardwareMonitor (usa driver kernel WinRing0 — **vulnerável, bloqueado por Defender**). Não usar.
- NVML/ADLX para GPU (confiável).
- **MVP:** usar WMI se disponível; senão, proxy por throttling (`\Processor Information(_Total)\% Performance Limit`). Documentar limitação.

---

## 5. Protocolos de comunicação

### 5.1 Resumo

| Canal | Protocolo | Auth |
|---|---|---|
| Dashboard ↔ API | HTTPS REST/JSON, SSE para live updates | OIDC (sessão cookie HttpOnly) |
| CLI admin ↔ API | HTTPS REST/JSON | Token pessoal com escopo |
| Worker ↔ Gateway | gRPC bidi streaming, HTTP/2, TLS 1.3 | mTLS (cert do Worker) |
| Worker ↔ Object Store | HTTPS GET/PUT | URL pré-assinada, TTL 10 min, escopo 1 objeto |
| Tray ↔ Agent | Named pipe, mensagens protobuf length-prefixed | DACL + verificação de SID do cliente |
| Agent ↔ Sandbox | stdin/stdout (pipes anônimos), protobuf | Herança de handle única |

### 5.2 Serviço gRPC do Worker (esboço, não código)

```
service WorkerGateway {
  rpc Enroll(EnrollRequest) returns (EnrollResponse);         // TLS sem cert cliente, token único
  rpc RenewCert(RenewRequest) returns (RenewResponse);        // mTLS
  rpc Session(stream WorkerMessage) returns (stream ServerMessage);  // mTLS
}

WorkerMessage (oneof):
  Hello{agent_version, worker_id, hardware, policy_snapshot}
  Heartbeat{state, usage, available_capacity, running_tasks}   // a cada 5 s
  TaskAccept{lease_id}
  TaskReject{lease_id, reason}
  TaskProgress{lease_id, percent, stage, metrics}             // no máx. 1/s
  TaskLog{lease_id, seq, lines[]}                              // limitado, truncado
  TaskResult{lease_id, output_ref, output_sha256, exit, usage}
  TaskFailed{lease_id, error_class, message}
  TaskPreempted{lease_id, reason, checkpoint_ref?}
  StateChange{from, to, reason}                                // pausado pelo dono etc.

ServerMessage (oneof):
  Welcome{server_time, config, min_agent_version}
  TaskOffer{lease_id, task_id, module_ref, module_sha256, module_signature,
            input_urls[], output_upload_url, limits, lease_ttl, deadline}
  CancelTask{lease_id, reason}
  ExtendLease{lease_id, new_ttl}
  Drain{}                         // não aceitar mais tarefas
  Revoke{}                        // parar tudo, apagar credenciais
```

Regras:
- Todas as mensagens têm `msg_id` + `seq` para idempotência.
- Lease renovado implicitamente por heartbeat. Sem heartbeat por `3 × intervalo` → lease expira, task volta à fila.
- Servidor **oferece**; Worker **aceita ou rejeita** (Policy Engine local). Nunca push forçado.
- Versionamento: `proto` com pacote `ghost.worker.v1`. Campos só adicionados.

---

## 6. Modelo de dados (PostgreSQL)

```
users            (id, email, display_name, role[admin|operator|viewer], oidc_subject, created_at, disabled_at)
api_tokens       (id, user_id, name, hash, scopes[], expires_at, last_used_at, revoked_at)

workers          (id uuid, name, owner_user_id, status[pending|active|revoked],
                  cert_serial, cert_expires_at, agent_version, os_version,
                  last_seen_at, state[disabled|waiting|available|running|paused|stopped|offline],
                  labels jsonb, created_at, revoked_at)
worker_hardware  (worker_id PK, cpu_model, cpu_cores, cpu_threads, cpu_features[], ram_mb,
                  gpus jsonb, disk_free_mb, updated_at)
worker_policies  (worker_id PK, policy jsonb, source[local|server], version, updated_at)
worker_usage     (worker_id, ts, cpu_total, cpu_ghost, ram_used_mb, ram_ghost_mb,
                  gpu_util, temp_c, user_idle_s)          -- particionada por dia, retenção 7–14 d
enrollment_tokens(id, token_hash, created_by, expires_at, used_at, used_by_worker_id)

modules          (id, name, version, sha256, size_bytes, signature, signer_key_id,
                  manifest jsonb,           -- limites padrão, suporta checkpoint, formato I/O
                  status[draft|approved|deprecated|blocked], approved_by, created_at)
signing_keys     (id, public_key, algorithm, status, created_at, revoked_at)

jobs             (id, name, module_id, created_by, priority, status[queued|running|completed|failed|cancelled],
                  params jsonb, total_tasks, completed_tasks, failed_tasks,
                  max_retries, redundancy, deadline, created_at, started_at, finished_at)
tasks            (id, job_id, index, status[pending|leased|running|succeeded|failed|preempted|cancelled],
                  input_ref, input_sha256, requirements jsonb,  -- cpu, ram, features
                  attempts, last_error, result_ref, result_sha256, created_at, updated_at)
leases           (id, task_id, worker_id, status[offered|accepted|running|completed|expired|rejected|preempted|cancelled],
                  offered_at, accepted_at, expires_at, finished_at, usage jsonb)
task_events      (id, task_id, lease_id, ts, type, payload jsonb)   -- progresso, estados
artifacts        (id, kind[module|input|output|checkpoint|log], bucket, key, sha256, size, created_at, expires_at)

audit_log        (id bigserial, ts, actor_type[user|worker|system], actor_id, action, target_type,
                  target_id, ip, details jsonb, prev_hash, hash)   -- encadeado, append-only
```

Índices-chave: `tasks(status, job_id)`, `leases(worker_id, status)`, `leases(expires_at) WHERE status IN ('accepted','running')`.

---

## 7. Fluxo de autenticação

### 7.1 Humanos
1. Dashboard redireciona para IdP OIDC (Keycloak self-hosted, ou Google/Entra da organização).
2. API valida ID token, cria sessão (cookie `HttpOnly; Secure; SameSite=Strict`), CSRF token.
3. RBAC: `admin` (tudo), `operator` (jobs, ver workers), `viewer` (leitura).
4. Ações sensíveis (aprovar módulo, revogar worker, gerar enrollment) exigem reautenticação recente.

### 7.2 Enrollment de Worker
```
Admin ──► API: cria enrollment token (uso único, TTL 1 h, vinculado a owner)
Admin ──► dono: entrega token (fora de banda)
Instalador (MSI assinado) ──► pede token ao dono
Agent: gera par de chaves ECDSA P-256
       └─ preferir Microsoft Platform Crypto Provider (TPM, não exportável); fallback: CNG software + DPAPI
Agent ──► Gateway.Enroll{token, CSR, hardware}   (TLS server-auth, pinning da CA do ghost)
Gateway: valida token (hash, não usado, não expirado) → marca usado → cria worker(status=pending|active)
CA: assina cert (CN=worker_id, validade 7 dias, EKU clientAuth)
Agent: armazena cert; conecta Session com mTLS
```
- Opção: exigir **aprovação manual** do admin após enrollment (`pending → active`).
- Renovação automática a partir de 50% da validade.
- Revogação: `workers.status=revoked` checado a cada handshake + `Revoke{}` no stream ativo. Certs curtos dispensam CRL/OCSP.

### 7.3 Confiança no código
- Chave de assinatura de módulos **offline** (Ed25519), fora do servidor.
- Agent tem as chaves públicas confiáveis embutidas + atualizáveis apenas por mensagem assinada pela chave raiz.
- Worker verifica: `sha256(module) == offer.sha256` **e** assinatura válida **e** chave não revogada. Senão rejeita e reporta.
- Comprometimento do servidor **não** permite executar código novo nos workers.

---

## 8. Fluxo de criação de jobs

```
1. Operador envia módulo (.wasm + manifest) → status=draft
2. Admin revisa, assina offline, envia assinatura → status=approved (auditado)
3. Operador cria job: {module_id, params, inputs[], prioridade, redundância, deadline}
   - inputs: upload para Object Store (URL pré-assinada) ou referência a artefato existente
4. API valida: módulo aprovado, limites dentro do manifest, tamanho de inputs
5. Splitter: gera N tasks (1 por input, ou por estratégia do manifest: range, chunk)
6. Tasks → status=pending; job → queued
7. Evento SSE ao Dashboard
```

Tipo de workload MVP: **embarrassingly parallel** (map puro). Sem comunicação entre tasks. Reduce opcional feito no servidor ou em task final.

---

## 9. Fluxo de execução

```
Scheduler (loop 1 s, lock advisory no Postgres)
  1. Expira leases vencidos → task.pending (attempts++) ou failed se > max_retries
  2. Para cada worker AVAILABLE com capacidade livre:
       seleciona task pending compatível (requirements ⊆ capacidade), prioridade, FIFO
       SKIP LOCKED → cria lease(offered, expires_at = now + 30 s)
  3. Gateway envia TaskOffer

Worker
  4. Policy Engine confere estado → TaskAccept | TaskReject
  5. Baixa módulo (cache por sha256) e inputs; verifica hashes e assinatura
  6. Cria diretório de trabalho temporário com ACL só para o AppContainer SID
  7. Lança ghost-sandbox.exe em Job Object (limites da oferta ∩ limites do dono)
  8. Sandbox → Agent: progresso via stdout protobuf; Agent → servidor: TaskProgress (throttle 1/s)
  9. Monitor contínuo: violação → PREEMPTING (checkpoint/kill) → TaskPreempted
 10. Término: Agent calcula sha256(output), PUT na URL pré-assinada, envia TaskResult
 11. Limpa diretório de trabalho (sempre, inclusive em falha)

Servidor
 12. Validator: confere hash do objeto armazenado, tamanho, schema do manifest
     redundância > 1: aguarda K resultados e compara; divergência → task em quarentena
 13. task.succeeded; job.completed quando todas terminam
```

Garantias:
- **At-least-once** por task. Módulos devem ser **determinísticos e idempotentes**.
- Cancelamento pelo operador: `CancelTask` → kill imediato → lease `cancelled`.
- Preempção não consome `attempts`, mas worker com excesso de preempções recebe menor prioridade.

---

## 10. Estratégia de segurança

### 10.1 Ameaças e mitigações

| Ameaça | Mitigação |
|---|---|
| Workload escapar para o host | WASM + AppContainer + Job Object + low integrity. Sem código nativo. Wasmtime atualizado. |
| Servidor comprometido envia código malicioso | Assinatura offline de módulos verificada no Worker. |
| Worker malicioso forja resultados | Hash, validação de schema, reputação objetiva por worker ([ADR 008](adr/008-open-platform.md)). **Aberto:** execução redundante / verificação por amostragem ainda não existe; na plataforma aberta um provedor pode devolver resultado errado com hash coerente. |
| Worker lê dados sensíveis de inputs | Plataforma aberta: **provedores veem os inputs dos jobs que executam**. Clientes não devem enviar dados sensíveis. Só tipos registrados; imagens só do lote atribuído. |
| Roubo de credencial do Worker | Chave em TPM, cert 7 dias, revogação imediata. |
| Token de enrollment vazado | Uso único, TTL curto, aprovação manual opcional. |
| Escalada local via agente | Serviço sem admin; pipe com DACL; nenhuma API de "executar comando". |
| Agent atualizado maliciosamente | Updates assinados (Authenticode + assinatura própria); canal separado. |
| Exfiltração pela rede | Sandbox sem rede. Agent só fala com hosts fixos (pinning). |
| DoS no host | Limites rígidos do Job Object; prioridade IDLE; kill imediato. |
| Side-channel (Spectre etc.) | Sem timers de alta resolução no WASI; sem threads compartilhadas no MVP. Risco residual: na plataforma aberta, jobs de clientes diferentes podem rodar lado a lado no mesmo computador. |
| Contas falsas (Sybil) para créditos grátis ou reputação | Cadastro limitado por IP, crédito de boas-vindas pequeno (`SIGNUP_CREDITS`), jobs do próprio dono não contam para reputação. **Aberto:** um provedor com várias contas ainda pode simular clientes. |
| Membro vê dados de outros | Papel `member`: só os próprios jobs, computadores e créditos; ids alheios respondem 404; sem WebSocket global nem painel. |
| Dashboard (XSS/CSRF) | CSP estrita, cookies SameSite, CSRF token, escape padrão do framework. |

### 10.2 Práticas
- TLS 1.3 em tudo. Nenhum segredo em logs.
- Segredos do servidor em arquivo com permissão restrita ou Vault (fase 2).
- Dependências fixadas, SBOM, `cargo audit`/`govulncheck`, Dependabot.
- Binários Windows assinados (Authenticode). Instalador MSI.
- Auditoria encadeada por hash para ações administrativas.
- Pen-test do sandbox antes de qualquer expansão da rede.

---

## 11. Estratégia de logs

| Fonte | Formato | Destino | Retenção |
|---|---|---|---|
| ghost-server | JSON estruturado (stdout) | Loki | 30 d |
| ghost-agent | JSON, arquivo rotativo `%ProgramData%\ghost\logs` (10 MB × 5) | Local + envio em lote ao servidor (nível ≥ INFO) | 7 d local |
| ghost-tray | JSON local | Local | 7 d |
| Workload (stdout/stderr) | Texto, **truncado** (64 KB/task) | TaskLog → Loki, rotulado por task | 7 d |
| Auditoria | Tabela `audit_log` | Postgres (+ export diário) | 1 ano |
| Windows Event Log | Eventos críticos do agente (start/stop/revoke/violação) | Event Viewer | padrão SO |

Campos padrão: `ts, level, service, version, worker_id, job_id, task_id, lease_id, trace_id, msg`.
Regras: sem PII, sem conteúdo de input/output, sem tokens. Redação automática de padrões de segredo. Log de workload tratado como não confiável (escape na UI).

---

## 12. Observabilidade

Stack: **OpenTelemetry SDK → OTel Collector → Prometheus (métricas) + Loki (logs) + Tempo (traces) → Grafana**. Dashboard do ghost consome API própria; Grafana é para operação.

Métricas-chave:
- **Frota:** workers por estado, conectados, versão do agente, capacidade total disponível (cores, RAM).
- **Scheduler:** tasks pending/leased/running, tempo em fila (p50/p95), taxa de ofertas rejeitadas, leases expirados.
- **Execução:** duração por módulo, taxa de sucesso/falha/preempção, retries, divergência em redundância.
- **Worker:** CPU/RAM do ghost vs. do dono, temperatura, motivos de preempção, tempo de reação à pausa.
- **Gateway:** conexões ativas, latência de heartbeat, erros de handshake mTLS.
- **API:** RED (rate, errors, duration) por rota.

Traces: `trace_id` propagado de `job create → task → lease → worker execution → result`.

Alertas iniciais: worker offline > 10 min com task ativa; taxa de falha de módulo > 20%; fila parada; cert de CA perto de expirar; tempo de reação à pausa > 1 s.

SLO interno crítico: **pausa do dono efetiva em < 1 s em 99,9%** dos casos (medido localmente, reportado).

---

## 13. Estrutura de diretórios (monorepo)

```
ghost/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── adr/                         # Architecture Decision Records
│   └── threat-model.md
├── proto/
│   └── ghost/worker/v1/*.proto      # contrato Worker ↔ Gateway, Tray ↔ Agent, Agent ↔ Sandbox
├── server/                          # Go
│   ├── cmd/ghost-server/
│   ├── cmd/ghostctl/                # CLI admin
│   ├── internal/
│   │   ├── api/                     # REST handlers
│   │   ├── gateway/                 # gRPC Worker
│   │   ├── scheduler/
│   │   ├── enrollment/  ca/
│   │   ├── modules/  jobs/  workers/
│   │   ├── validator/
│   │   ├── storage/                 # object store
│   │   ├── store/                   # Postgres, migrations
│   │   ├── auth/  audit/
│   │   └── telemetry/
│   └── migrations/
├── agent/                           # Rust (Windows)
│   ├── crates/
│   │   ├── ghost-agent/             # serviço
│   │   ├── ghost-sandbox/           # host Wasmtime
│   │   ├── ghost-tray/              # UI bandeja
│   │   ├── policy/                  # máquina de estados (testável, sem Windows)
│   │   ├── monitor/                 # PDH, DXGI, WMI
│   │   ├── winsec/                  # Job Object, AppContainer, tokens
│   │   ├── connector/               # gRPC client
│   │   └── ipc/
│   └── installer/                   # WiX (MSI)
├── sdk/
│   └── rust/ghost-module/           # SDK para escrever módulos (progresso, checkpoint, I/O)
├── modules/
│   └── examples/                    # ex.: hash-bruteforce-benchmark, mandelbrot, monte-carlo-pi
├── dashboard/                       # TypeScript + React + Vite
├── deploy/
│   ├── docker-compose.yml           # dev: postgres, minio, otel, grafana
│   └── grafana/  prometheus/  loki/
├── tools/                           # assinatura offline de módulos
└── .github/workflows/
```

---

## 14. Tecnologias recomendadas

| Área | Escolha | Motivo |
|---|---|---|
| Agent Windows | **Rust** (`windows-rs`, `tokio`, `tonic`) | Segurança de memória, acesso direto a Win32 (Job Objects, AppContainer, PDH), binário único, Wasmtime nativo. |
| Sandbox | **Wasmtime** + WASI preview1/p2 | Maduro, epoch interruption, limites de memória, mantido pela Bytecode Alliance. |
| Tray UI | Rust + `tray-icon`/`tauri` (mínimo) | Mesmo toolchain. |
| Instalador | WiX Toolset (MSI) assinado | Padrão corporativo, GPO/Intune. |
| Servidor | **Go** (`grpc-go`, `chi`/`net/http`, `pgx`) | Simples, concorrência boa, deploy fácil. (Alternativa: Rust para tudo — mais uniforme, mais lento de iterar.) |
| Banco | PostgreSQL 16 | Fila + estado + auditoria num lugar só. |
| Objetos | MinIO (dev/self-hosted) / S3 | API S3, URLs pré-assinadas. |
| Contratos | Protobuf + `buf` | Lint e breaking-change check. |
| Dashboard | React + TypeScript + Vite + TanStack Query | Padrão; SSE para tempo real. |
| AuthN | OIDC (Keycloak ou IdP existente) | Não reinventar login. |
| Observabilidade | OpenTelemetry, Prometheus, Loki, Tempo, Grafana | Aberto, padrão. |
| CI | GitHub Actions (runner Windows para o agente) | Build, testes, assinatura. |

---

## 15. Riscos técnicos

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| 1 | WASM limita workloads (sem GPU, sem SIMD amplo, perf ~0,6–0,9× nativo) | Alto | Aceitar no MVP; validar com benchmarks reais cedo. |
| 2 | Temperatura de CPU não disponível sem driver | Médio | Proxy por throttling; documentar; não usar WinRing0. |
| 3 | AppContainer para processo não-UWP tem arestas (ACLs de diretório, DLL loading) | Médio | Spike técnico na semana 1. |
| 4 | Medir "uso do dono" com precisão (ruído, turbo boost, SMT) | Médio | Média móvel + histerese; testes em máquinas reais. |
| 5 | Antivírus/EDR sinalizar o agente (comportamento de "miner") | Alto | Assinatura Authenticode, submissão à Microsoft, allowlist corporativa, nome/descrição transparentes. |
| 6 | Resultados incorretos de workers | Médio | Redundância, determinismo exigido. |
| 7 | Stream gRPC atrás de proxies corporativos | Médio | Fallback gRPC-Web/WebSocket sobre 443. |
| 8 | Laptops: bateria, sleep, rede instável | Médio | Pausa em bateria; lease curto; retomada limpa. |
| 9 | Vulnerabilidade no Wasmtime | Alto | Camadas extras (AppContainer/Job); atualização rápida; canal de update. |
| 10 | Postgres como fila vira gargalo | Baixo no MVP | OK até milhares de workers; NATS/Redis depois. |
| 11 | Checkpointing complexo | Baixo | Opcional por módulo; tasks curtas (< 10 min) como padrão. |
| 12 | Energia/desgaste do hardware do dono | Médio (confiança) | Limites conservadores por padrão; transparência no tray. |

---

## 16. Decisões pendentes (antes de implementar)

1. **Isolamento:** confirmar WASM-only no MVP (sem GPU executando). *Recomendo sim.*
2. **Linguagem do servidor:** Go vs. Rust. *Recomendo Go.*
3. **Workloads-alvo concretos:** quais 2–3 casos reais validam o MVP? (renderização? Monte Carlo? compressão? inferência CPU?) Define I/O, tamanho de tasks, necessidade de SIMD/threads.
4. **Versões de Windows suportadas:** 10 22H2+ e 11? Home incluído? (afeta Windows Sandbox/Hyper-V futuros).
5. **Hospedagem do control plane:** on-prem ou nuvem? Acesso dos workers via internet ou VPN (WireGuard/Tailscale)?
6. **IdP:** qual OIDC existente usar.
7. **Aprovação manual de worker** após enrollment: sim/não.
8. **Quem assina módulos** e onde fica a chave offline (YubiKey/HSM?).
9. **Redundância padrão:** 1 (confiança total) ou 2 (verificação)?
10. **Tamanho máximo** de input/output por task e cota de disco local.
11. **Política padrão** conservadora (ex.: 25% CPU, só idle, só fora do horário).
12. **Distribuição do agente:** MSI manual, Intune/GPO, auto-update.
13. **Telemetria enviada:** o que o dono consente em compartilhar (privacidade de uso do PC).
14. **Threads em WASM** (wasi-threads) no MVP ou single-thread por task com N tasks paralelas. *Recomendo N tasks single-thread.*

---

## 17. Ordem de desenvolvimento

| Fase | Entrega | Por quê primeiro |
|---|---|---|
| **0. Spikes (1–2 sem)** | (a) Wasmtime em AppContainer + Job Object no Windows, tentando escapar; (b) medir uso do dono e reação à pausa; (c) benchmark WASM vs. nativo nos workloads-alvo | Validam as duas premissas mais arriscadas: isolamento e controle do dono. Se falharem, arquitetura muda. |
| **1. Contratos** | `proto/` v1, modelo de dados, migrations, ADRs | Destrava trabalho paralelo em server/agent/dashboard. |
| **2. Agent local standalone** | Monitor, Policy Engine, Sandbox, Tray (pausar/parar), executa módulo de arquivo local | Núcleo de segurança e confiança. Testável sem servidor. |
| **3. Server mínimo** | Enrollment + CA + Gateway + heartbeats + registro de hardware | Requisitos 1–4 do MVP. |
| **4. Jobs + Scheduler** | Módulos assinados, criação de jobs, split, leases, resultados, retries | Requisitos 5–9. Depende de 2 e 3. |
| **5. Dashboard** | Workers, jobs, tasks, progresso ao vivo, ações admin | Requisito 10. API já estável. Até aqui, `ghostctl` basta. |
| **6. Observabilidade + endurecimento** | OTel, alertas, auditoria, pen-test do sandbox, instalador MSI assinado | Pré-requisito para ampliar a rede. |
| **7. Piloto** | 5–10 máquinas internas por 2–4 semanas | Dados reais de preempção, falhas, AV/EDR. |

**Razão da ordem:** o risco do produto está na máquina do voluntário, não no servidor. Scheduler e dashboard são problemas conhecidos; sandbox seguro e respeito aos limites do dono não. Validar isso primeiro evita construir um control plane em cima de uma premissa falsa.
