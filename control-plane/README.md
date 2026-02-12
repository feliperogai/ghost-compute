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
migrations/            SQL versionado
```

**Fonte de verdade:** Postgres. Redis guarda o índice da fila de jobs, o barramento de eventos e o lock de líder do scheduler. Se o Redis perder dados, o scheduler reconstrói o índice a partir do Postgres.

**Jobs e scheduler:** ver [ADR 002](../docs/adr-002-job-model-and-scheduler.md).

```
src/scheduler/   algoritmo (puro, substituível): elegibilidade, estratégia, retry, engine
src/jobs/        persistência e API: lifecycle (transições), scheduler-store (ports), runner (líder), rotas
```

Estados: `QUEUED → ASSIGNED → RUNNING → COMPLETED | FAILED | TIMEOUT`, e `CANCELLED` a partir de qualquer estado não terminal. Cada tentativa é uma assignment com score e motivo de término.

## Autenticação

| Quem | Como |
|---|---|
| Usuário | `Authorization: Bearer ghu_…` (token de API; só o hash é salvo). Papéis: `viewer` < `operator` < `admin`. |
| Worker (registro) | Token de enrollment `ghe_…` de uso único, gerado por admin, com TTL. |
| Worker (sessão) | `POST /v1/workers/auth` com `workerId` + `workerSecret` (`ghw_…`) → token HMAC `v1.…` de curta duração. Revogação checada em toda requisição. |

Endpoints de credenciais têm rate limit (20/min por IP, via Redis).

## Endpoints

| Método | Rota | Quem | Função |
|---|---|---|---|
| POST | `/v1/admin/users` | admin | cria usuário + token |
| POST | `/v1/admin/enrollment-tokens` | admin | token de registro de Worker |
| POST | `/v1/workers/register` | enrollment token | 1. registrar Worker |
| POST | `/v1/workers/auth` | secret do worker | 2. autenticar Worker |
| POST | `/v1/workers/:id/revoke` | admin | 3. revogar Worker |
| GET | `/v1/workers` | viewer | 4. listar (`status`, `state`, `limit`, `offset`) |
| GET | `/v1/workers/:id` | viewer | 5. status + atribuições ativas |
| GET | `/v1/workload-types` | viewer | catálogo de tipos de workload |
| POST | `/v1/jobs` | operator | criar Job (`type, requirements, resources, priority, timeout, maxAttempts, input`) |
| GET | `/v1/jobs/:id` | viewer | Job completo + histórico de tentativas (score, motivo) |
| GET | `/v1/jobs/:id/events` | viewer | trilha de eventos |
| POST | `/v1/jobs/:id/cancel` | dono ou admin | cancelar |
| GET | `/v1/jobs` | viewer | histórico (`status`, `type`, `owner=me\|uuid`, `since`, `until`, cursor) |
| POST | `/v1/worker/heartbeat` | worker | estado, uso, **capacidade**, **tipos suportados** → `assignments`, `cancelAssignmentIds` |
| — | scheduler | — | detecta offline, expira, recupera, aplica timeout, aloca |
| GET | `/v1/worker/assignments` | worker | atribuições pendentes (também via WS `job.assigned`) |
| POST | `/v1/worker/assignments/:id/accept` · `/reject` | worker | aceitar/recusar |
| POST | `/v1/worker/assignments/:id/progress` | worker | progresso (0–1, `stage`) |
| POST | `/v1/worker/assignments/:id/result` | worker | `completed` (output + sha256) · `failed` (`error`, `retryable`) |
| GET | `/v1/worker/me/stats` | worker | contagens, créditos internos, histórico |
| GET | `/healthz` · `/readyz` | — | liveness / readiness |

## WebSocket `GET /v1/ws`

Autenticação por header `Authorization` ou primeira mensagem `{"type":"auth","token":"…"}` em até 5 s. Tokens nunca vão na URL.

- **Usuário** recebe `{"type":"event","event":{type,ts,data}}`. Pode filtrar: `{"type":"subscribe","types":["job."],"jobId":"…"}`.
  Eventos: `worker.registered|online|offline|state|heartbeat|revoked`, `job.created|updated|progress`.
- **Worker** recebe `job.assigned`, `assignment.cancel`, `worker.revoked` (a conexão fecha com código 4003). Ofertas pendentes são reenviadas ao conectar.

Códigos de fechamento: 4001 não autorizado · 4003 revogado · 4008 timeout de auth · 1008 rate limit.

## Logs

JSON (pino) com `reqId` (aceita `x-request-id`), `userId`/`workerId` após auth, `service`. Header `authorization` e campos de segredo são redigidos. Ações administrativas vão para `audit_log`.

## Fora do escopo (ainda)

Execução de código, registro/assinatura de módulos, object store para blobs grandes, mTLS, OIDC, métricas OpenTelemetry.
