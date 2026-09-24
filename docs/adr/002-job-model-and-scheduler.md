# ADR 002 — Modelo de Job e scheduler plugável

> Atualização: o score padrão agora é o do [ADR 006](006-explainable-scoring.md) (explicável, com registro de cada decisão).

**Status:** aceito. Substitui o modelo "job → tasks → leases" do MVP inicial.

## Decisão

**Job é a unidade de trabalho.** Campos: `id, owner, type, requirements, resources, status, priority, createdAt, startedAt, finishedAt, timeout, input, output, error` (+ `name` opcional, `maxAttempts`, `failures`, `progress`, `pendingReason`).

- `requirements`: o que o worker **precisa ter** (SO, extensões de CPU, núcleos/RAM físicos, fabricante e VRAM da GPU).
- `resources`: o que o job **reserva** enquanto roda (núcleos, RAM, GPU, VRAM, disco). O scheduler desconta isso da capacidade oferecida pelo worker.
- `type`: tipo de workload do catálogo (`wasm-cpu`, `wasm-gpu`). É um runtime em sandbox, nunca um comando. O worker declara os tipos que executa.
- Cada tentativa é uma **assignment** (`job_assignments`), com score, detalhamento e recursos reservados. É o histórico que permite reencaminhar e excluir workers que falharam.

```
QUEUED ──assign──▶ ASSIGNED ──accept──▶ RUNNING ──result ok──▶ COMPLETED
  ▲                   │ reject/expira        │ falha / worker sumiu / offline
  └───────────────────┴──────── política de retry ────────┘──▶ FAILED
                                              │ passou do timeout ──▶ TIMEOUT
  qualquer estado não terminal ── cancel ──▶ CANCELLED
```

## Scheduler (`control-plane/src/scheduler/`)

Não depende de Fastify, Postgres ou Redis.

| Arquivo | Papel | Substituível |
|---|---|---|
| `eligibility.ts` | Restrições rígidas: online, aceitando, tipo, SO, CPU, RAM, GPU/fabricante/VRAM, disco, temperatura, slots, exclusões | Não. É a garantia de segurança |
| `strategy.ts` | `PlacementStrategy.place(jobs, workers)` + registro por nome | **Sim** (`SCHEDULER_STRATEGY`) |
| `strategies/weighted.ts` | Padrão: guloso por prioridade, score ponderado | Sim (pesos configuráveis) |
| `retry.ts` | `RetryPolicy`: re-enfileirar ou falhar | Sim |
| `engine.ts` | Uma passada: monitores, colocação, revalidação | — |
| `ports.ts` | Interfaces para dados e monitores | Implementação em `src/jobs/scheduler-store.ts` |

**Score padrão** (componentes em [0,1], pesos padrão):

| Componente | Peso |
|---|---|
| Folga de CPU após alocar | 0,20 |
| Folga de RAM | 0,15 |
| GPU: folga de VRAM em jobs de GPU; preferir workers sem GPU em jobs de CPU | 0,10 |
| Distância do limite de temperatura | 0,15 |
| Carga (uso de CPU do dono e slots ocupados) | 0,20 |
| Confiabilidade (sucesso nas últimas 20 tentativas) | 0,15 |
| Frescor do heartbeat | 0,05 |

**Defesa em profundidade contra sobrealocação:**
1. A estratégia reserva capacidade dentro do lote.
2. O engine revalida cada colocação com as restrições rígidas e descarta a inválida.
3. O banco recheca slots, CPU, RAM, VRAM e GPU sob lock da linha do worker. O lock é obtido numa instrução separada da soma das reservas. Na mesma instrução, o Postgres (READ COMMITTED) somaria com o snapshot de antes da espera pelo lock e deixaria passar sobrealocação. Isso foi reproduzido em teste de estresse: 4 jobs de 2 núcleos num worker de 4 núcleos.

**Retry padrão:**

| Situação | Resultado |
|---|---|
| Recusa do worker | Re-enfileira; não conta como falha; o worker fica excluído desse job por 60 s |
| Não aceito a tempo, worker sumiu ou offline, falha `retryable` | Re-enfileira até `maxAttempts`; o worker que falhou fica excluído desse job |
| Falha não `retryable` | FAILED (`JOB_FAILED`) |
| Timeout | TIMEOUT (terminal) e o worker recebe ordem de parar |

**Explicabilidade:** um job que não pode ser alocado recebe `pendingReason`, por exemplo `no eligible worker (3× TOO_HOT, 1× INSUFFICIENT_RAM)`.

## Consequências

- O worker precisa declarar `capacity` e `workloadTypes` no heartbeat. O agente atual declara zero tipos, então nunca recebe job até existir executor.
- Lotes de muitos inputs viram N jobs. Não há agrupamento (batch) por enquanto.
