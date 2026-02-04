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
  queue/task-queue.ts  sorted set Redis (prioridade, idade)
  scheduler/           líder único: offline, expiração, dispatch, reconciliação
  modules/{admin,workers,jobs,leases}
migrations/            SQL versionado
```

**Fonte de verdade:** Postgres. Redis é índice da fila + barramento de eventos. Se o Redis perder dados, o scheduler reconstrói a fila a partir das tasks `pending`.

**Concorrência:** toda transição de estado ocorre em transação com ordem fixa de locks `worker → job → task → lease`. Um índice único parcial garante no máximo um lease ativo por task.

### Estados

```
task:  pending → leased → running → succeeded
                  │         ├──→ failed        (attempts > maxRetries)
                  │         └──→ pending       (falha com retry, preempção, expiração)
                  └──→ pending (rejeitado)      * qualquer não-terminal → cancelled
lease: offered → running → succeeded | failed | preempted
          └→ rejected | expired | cancelled
job:   queued → running → completed | failed | cancelled
```

Falha e expiração consomem tentativa. Preempção, rejeição e revogação do worker não consomem.

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
| GET | `/v1/workers/:id` | viewer | 5. status + leases ativos |
| POST | `/v1/jobs` | operator | 6. criar Job (1 task por item de `inputs`) |
| GET | `/v1/jobs/:id` | viewer | 7. consultar Job (+ contagem e progresso) |
| GET | `/v1/jobs/:id/tasks` | viewer | tasks, inputs e outputs |
| GET | `/v1/jobs/:id/events` | viewer | trilha de eventos |
| POST | `/v1/jobs/:id/cancel` | operator | 8. cancelar Job |
| GET | `/v1/jobs` | viewer | 9. histórico (cursor, `status`, `module`, `since`, `until`) |
| POST | `/v1/worker/heartbeat` | worker | 10. heartbeat → `cancelLeaseIds`, `offers` |
| — | scheduler | — | 11. detecta offline, libera leases |
| POST | `/v1/worker/leases/claim` | worker | 12. pull de tarefas (push via WS também) |
| POST | `/v1/worker/leases/:id/accept` · `/reject` | worker | aceitar/recusar oferta |
| POST | `/v1/worker/leases/:id/progress` | worker | 13. progresso (0–1, `stage`) |
| POST | `/v1/worker/leases/:id/result` | worker | 14. `succeeded` (output + sha256) · `failed` · `preempted` |
| GET | `/healthz` · `/readyz` | — | liveness / readiness |

## WebSocket `GET /v1/ws`

Autenticação por header `Authorization` ou primeira mensagem `{"type":"auth","token":"…"}` em até 5 s. Tokens nunca vão na URL.

- **Usuário** recebe `{"type":"event","event":{type,ts,data}}`. Pode filtrar: `{"type":"subscribe","types":["job."],"jobId":"…"}`.
  Eventos: `worker.registered|online|offline|state|heartbeat|revoked`, `job.created|updated|cancelled`, `task.updated|progress`.
- **Worker** recebe `task.offer`, `lease.cancel`, `worker.revoked` (a conexão fecha com código 4003). Ofertas pendentes são reenviadas ao conectar.

Códigos de fechamento: 4001 não autorizado · 4003 revogado · 4008 timeout de auth · 1008 rate limit.

## Logs

JSON (pino) com `reqId` (aceita `x-request-id`), `userId`/`workerId` após auth, `service`. Header `authorization` e campos de segredo são redigidos. Ações administrativas vão para `audit_log`.

## Fora do escopo (ainda)

Execução de código, registro/assinatura de módulos, object store para blobs grandes, mTLS, OIDC, métricas OpenTelemetry.
