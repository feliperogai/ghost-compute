# ghost control plane

API REST + WebSocket que registra Workers, distribui tarefas e acompanha Jobs.
Não executa código: só coordena.

Stack: Node 22 · TypeScript · Fastify 5 · PostgreSQL 16 · Redis 7 · Zod · Vitest.

## Rodar

```bash
cp .env.example .env                       # ajuste WORKER_TOKEN_SECRET
docker compose up -d postgres redis
npm ci
npm run migrate
npm run create-admin -- admin@example.com  # imprime o token uma única vez
npm run dev
```

Tudo em Docker: `WORKER_TOKEN_SECRET=... docker compose up --build`.

## Testes

Precisam de Postgres e Redis locais (`docker compose up -d postgres redis`).

```bash
createdb ghost_test   # uma vez
npm test              # TEST_DATABASE_URL / TEST_REDIS_URL para sobrescrever
npm run typecheck
```

## Arquitetura

```
src/
  app.ts               Fastify: plugins, erros, rotas
  server.ts            entrypoint, migrations, scheduler, shutdown gracioso
  config.ts            env validado (zod)
  errors.ts            AppError + handler → {error:{code,message,details,requestId}}
  auth/                tokens (hash SHA-256), HMAC do Worker, RBAC
  db/                  pool, transações, migrator (advisory lock)
  events/bus.ts        Redis pub/sub (multi-instância)
  events/ws.ts         WebSocket /v1/ws
  queue/job-queue.ts   índice de jobs QUEUED no Redis (prioridade, idade)
  modules/{admin,workers}
  scheduler/           algoritmo de alocação (independente)
  jobs/                ciclo de vida, API, adaptador do scheduler
  credits/             créditos virtuais: regras (pricing), ledger imutável, API
  market/              plataforma aberta: ofertas, reputação objetiva, cadastro, cotação
migrations/            SQL versionado
```

**Fonte de verdade:** Postgres. Redis guarda o índice da fila de jobs, o barramento de eventos e o lock de líder do scheduler. Se o Redis perder dados, o scheduler reconstrói o índice a partir do Postgres.

**Jobs e scheduler:** ver [ADR 002](../docs/adr/002-job-model-and-scheduler.md).

```
src/scheduler/   algoritmo (puro, substituível): elegibilidade, estratégia, retry, engine
src/jobs/        persistência e API: lifecycle (transições), scheduler-store (ports), runner (líder), rotas
```

Estados: `QUEUED → ASSIGNED → RUNNING → COMPLETED | FAILED | TIMEOUT`, e `CANCELLED` a partir de qualquer estado não terminal. Cada tentativa é uma assignment com score e motivo de término.

## Autenticação

| Quem | Como |
|---|---|
| Usuário | `Authorization: Bearer ghu_…` (token de API; só o hash é salvo). Papéis: `member` (conta pública: só os próprios dados) < `viewer` < `operator` < `admin` (equipe). |
| Worker (registro) | Token de enrollment `ghe_…` de uso único, gerado por admin, com TTL. |
| Worker (sessão) | `POST /v1/workers/auth` com `workerId` + `workerSecret` (`ghw_…`) → token HMAC `v1.…` de curta duração. Revogação checada em toda requisição. |

Rate limit global por credencial (ou IP) em toda a API, `RATE_LIMIT_PER_MINUTE`; rotas de credenciais e cadastro têm limites mais baixos. Atrás de proxy, defina `TRUST_PROXY` (senão `X-Forwarded-For` é ignorado) e `REQUIRE_TLS=true`. Controles e checklist de implantação: [docs/security/AUDIT.md](../docs/security/AUDIT.md).

## Endpoints

| Método | Rota | Quem | Função |
|---|---|---|---|
| POST | `/v1/signup` | — | conta pública `member` + token (limite por IP; `OPEN_SIGNUP`, `SIGNUP_CREDITS`) — [ADR 008](../docs/adr/008-open-platform.md) |
| GET | `/v1/me` · `/v1/me/tokens` | member | conta; tokens (validade, último uso) |
| POST · DELETE | `/v1/me/tokens` · `/v1/me/tokens/:id` | member | criar token (validade máxima `MEMBER_TOKEN_TTL_DAYS`) · revogar |
| POST | `/v1/admin/users` | admin | cria usuário + token |
| POST | `/v1/admin/enrollment-tokens` | admin | token de registro de Worker |
| POST | `/v1/workers/register` | enrollment token | 1. registrar Worker |
| POST | `/v1/workers/auth` | secret do worker | 2. autenticar Worker |
| POST | `/v1/workers/:id/revoke` | admin | 3. revogar Worker |
| GET | `/v1/workers` | viewer | 4. listar (`status`, `state`, `limit`, `offset`) |
| GET | `/v1/workers/:id` | viewer | 5. status + atribuições ativas |
| GET | `/v1/workload-types` | viewer | catálogo de tipos de workload |
| POST | `/v1/jobs` | member | criar Job (`type, requirements` + `minReputation`, `resources, priority, timeout, maxAttempts, budget, verification, input`); `verification: replicate` (padrão de contas públicas) exige resultados iguais de donos e redes diferentes |
| GET | `/v1/jobs/:id` | viewer | Job completo + histórico de tentativas (score, motivo) |
| GET | `/v1/jobs/:id/events` | viewer | trilha de eventos |
| GET | `/v1/jobs/:id/decisions` | viewer | por que cada tentativa foi para cada worker ("Worker X foi escolhido porque...", termos, pesos, segundo colocado) — [ADR 006](../docs/adr/006-explainable-scoring.md) |
| POST | `/v1/jobs/:id/cancel` | dono ou admin | cancelar |
| GET | `/v1/jobs` | viewer | histórico (`status`, `type`, `owner=me\|uuid`, `since`, `until`, cursor) |
| POST | `/v1/datasets` · `/:id/images` · `/:id/seal` | operator | dataset de imagens PNG/JPEG ([ADR 004](../docs/adr/004-image-inference.md)) |
| POST | `/v1/inference` | operator | inferência em lotes paralelos (`datasetId, batchSize, accelerator, topK, timeoutSeconds, maxAttempts`) |
| GET | `/v1/inference/:id` · `/result` | dono | progresso · resultado combinado com `resultSha256` |
| POST | `/v1/inference/:id/cancel` | dono | cancelar todos os lotes |
| POST | `/v1/worker/heartbeat` | worker | estado, uso, **capacidade**, **tipos suportados** → `assignments`, `cancelAssignmentIds` |
| — | scheduler | — | detecta offline, expira, recupera, aplica timeout, aloca |
| GET | `/v1/worker/assignments` | worker | atribuições pendentes (também via WS `job.assigned`) |
| POST | `/v1/worker/assignments/:id/accept` · `/reject` | worker | aceitar/recusar |
| POST | `/v1/worker/assignments/:id/progress` | worker | progresso (0–1, `stage`, `checkpoint` validado) |
| GET | `/v1/worker/assignments/:id/images/:index` | worker | bytes de uma imagem do próprio lote (`image-inference`) |
| POST | `/v1/worker/assignments/:id/result` | worker | `completed` (output + sha256) · `failed` (`error`, `retryable`) |
| GET | `/v1/worker/me/stats` | worker | contagens, créditos ganhos (do ledger), histórico |
| GET | `/v1/worker/calibration/ping` · `/:id/download` · POST `/:id/upload` · `/:id/report` | worker | calibração: latência, banda (stream por nonce), relatório verificado ([ADR 005](../docs/adr/005-worker-calibration.md)) |
| GET | `/v1/workers/:id/profile` | viewer | `WorkerPerformanceProfile`, resumo, throughput observado, histórico |
| POST | `/v1/workers/:id/calibrate` | admin | forçar nova calibração |
| GET | `/v1/dashboard/overview` · `/history?range=1h\|6h\|24h\|7d` · `/workers` · `/workers/:id` · `/errors` | viewer | observabilidade para o [painel](../dashboard/) (servido em `/dashboard/`) |
| POST | `/v1/provider/enrollment-tokens` | member | token para registrar um computador próprio |
| GET | `/v1/provider/workers` | member | meus computadores: estado, oferta, reputação, saldo |
| GET · PUT | `/v1/provider/workers/:id/offer` | dono | preço (créditos/min por recurso), disponibilidade (janelas no fuso), limites, `listed` |
| POST | `/v1/provider/workers/:id/revoke` | dono | tirar um computador da plataforma (roubado/comprometido) |
| GET | `/v1/market/offers` | member | mercado: hardware, preço, janelas, limites, reputação (`type`, `gpu`, `availableNow`) |
| GET | `/v1/market/workers/:id/reputation` | member | reputação com métricas (concluídos, falhas, uptime, resposta) |
| POST | `/v1/market/quote` | member | quem aceitaria o job e o custo máximo, pelas regras do scheduler |
| GET | `/v1/credits/wallet` | viewer | saldo (derivado do ledger), reservas abertas, totais por tipo — [ADR 007](../docs/adr/007-internal-credits.md) |
| GET | `/v1/credits/transactions` | viewer | extrato da própria carteira, com saldo após cada movimento (`kind`, cursor) |
| GET | `/v1/credits/earnings` | viewer | ganhos dos próprios workers (admin: todos), com o cálculo de cada um (`workerId`) |
| GET | `/v1/credits/spending` | viewer | custo de cada job: reservado, cobrado, devolvido, tentativas cobradas |
| GET | `/v1/credits/workers/:id/wallet` · `/transactions` | dono ou admin | carteira de um worker |
| POST | `/v1/credits/workers/:id/withdraw` | dono (operator) | ganhos do worker → carteira do dono (`amount`, `idempotencyKey`) |
| POST | `/v1/credits/grants` | admin | conceder créditos (`userId`, `amount`, `reason`, `idempotencyKey`) |
| GET | `/v1/credits/ledger` · `/ledger/verify` · `/summary` | admin | ledger completo com hashes · recálculo de todos os invariantes · totais |
| GET | `/healthz` · `/readyz` | — | liveness / readiness |

## WebSocket `GET /v1/ws`

Autenticação por header `Authorization` ou primeira mensagem `{"type":"auth","token":"…"}` em até 5 s. Tokens nunca vão na URL.

- **Usuário** recebe `{"type":"event","event":{type,ts,data}}`. Pode filtrar: `{"type":"subscribe","types":["job."],"jobId":"…"}`.
  Eventos: `worker.registered|online|offline|state|heartbeat|revoked`, `job.created|updated|progress`, `inference.created|finished`, `worker.calibration.requested`, `worker.profiled`.
- **Worker** recebe `job.assigned`, `assignment.cancel`, `worker.revoked` (a conexão fecha com código 4003). Ofertas pendentes são reenviadas ao conectar.

Códigos de fechamento: 4001 não autorizado · 4003 revogado · 4008 timeout de auth · 1008 rate limit.

## Métricas

- **Latência e erros da API:** histograma por minuto e por instância, na tabela `api_metrics`.
- **Erros 5xx:** gravados com o request id na tabela `api_errors`.
- **Por worker:** uma amostra por minuto, a partir dos heartbeats, em `worker_metrics`.
- **Rede inteira:** um snapshot por minuto em `network_metrics`, gravado por uma instância de cada vez.
- **Retenção:** 7 dias.

## Logs

JSON (pino) com `reqId` (aceita `x-request-id`), `userId`/`workerId` após auth, `service`. Header `authorization` e campos de segredo são redigidos. Ações administrativas vão para `audit_log`.

## Fora do escopo (ainda)

Registro/assinatura de módulos, object store para blobs grandes, mTLS, OIDC, métricas OpenTelemetry.
