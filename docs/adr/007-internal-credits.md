# ADR 007 — Créditos internos com ledger imutável

**Status:** aceito. Substitui o contador "1 crédito = 1 minuto" de `/v1/worker/me/stats`.

## Escopo

- Créditos **virtuais**, só dentro da rede.
- Não há compra, venda, saque em dinheiro, câmbio nem marketplace.
- Créditos nascem de duas formas:
  - concessão de um admin;
  - ganho de um worker.
- Créditos são consumidos ao rodar jobs.

## Modelo

Partidas dobradas, somente inserção (`migrations/008_credits.sql`).

| Tabela | Conteúdo |
|---|---|
| `credit_wallets` | Uma por usuário e uma por worker, mais três carteiras de sistema: `issuance` (origem de todo crédito, a única que pode ficar negativa), `escrow` (reservas de jobs) e `consumption` (destino do que foi gasto). |
| `credit_transactions` | Um evento de negócio. `kind` pode ser `grant`, `earning`, `hold`, `settlement` ou `withdrawal`. Guarda: chave de idempotência única, referências (job, tentativa, worker), ator, memo, cálculo completo em `detail`, `prev_hash` e `hash`. |
| `credit_entries` | Movimentos da transação, em milicréditos inteiros e diferentes de 0. Cada transação soma 0. |

**Saldo nunca é gravado.** O saldo é `SUM(credit_entries.amount)` da carteira. Não existe coluna de saldo (há teste que garante isso). O extrato mostra o saldo após cada movimento, calculado com função de janela.

## Fluxos

| Evento | Transação | Movimentos |
|---|---|---|
| Usuário criado | `grant` (`signup:user:<id>`) | issuance → usuário (`CREDITS_INITIAL_GRANT`, padrão 1000) |
| Admin concede | `grant` (`grant:<chave>`) | issuance → usuário |
| Job criado | `hold` (`hold:job:<id>`) | usuário → escrow, no valor de `ceil(taxa × timeout / 60)` |
| Tentativa produtiva termina | `earning` (`earning:assignment:<id>`) | issuance → worker |
| Job termina | `settlement` (`settlement:job:<id>`) | escrow → consumption (custo) + escrow → usuário (sobra) |
| Dono transfere ganhos | `withdrawal` | worker → usuário dono |

- **Job e reserva na mesma transação SQL.** Sem crédito não há job, nem na fila. Uma inferência reserva todos os lotes, ou nenhum.
- **Movimentos junto com o estado.** Ganho e liquidação acontecem na mesma transação SQL da mudança de estado do job (`lifecycle.ts`). Se um falha, os dois voltam.
- **Tentativa produtiva:**
  - uma tentativa `completed`;
  - uma tentativa `timeout` de job retomável (o checkpoint foi aproveitado).
- **Cobrança:**
  - só jobs `COMPLETED` são cobrados;
  - o dono paga Σ `ceil(taxa × segundos / 60)` das tentativas produtivas;
  - a cobrança nunca passa do valor reservado;
  - `FAILED`, `TIMEOUT` e `CANCELLED` devolvem tudo.
- **Jobs anteriores aos créditos:** um job sem reserva não é cobrado.

## Regras de cálculo (`src/credits/pricing.ts`)

As funções são puras. Todas as entradas ficam em `detail`, então qualquer valor pode ser recalculado à mão (há teste que faz isso).

```
taxa (milicréditos/min) = 1000 × núcleos + 250 × GB RAM + 4000 × GPU + 250 × GB VRAM
ganho = floor(segundos / 60 × taxa × desempenho × disponibilidade)
```

| Fator pedido | Como entra |
|---|---|
| Tempo de computação | Segundos da tentativa (`finished_at − started_at`, relógio do banco). |
| Recursos utilizados | A taxa, calculada sobre os recursos reservados. |
| Performance | Score verificado do dispositivo que rodou (GPU ou CPU) ÷ 1000, limitado a 0,5–2. Sem perfil verificado: 0,75. |
| Disponibilidade | 0,8 + 0,4 × fração das últimas 24 h em `available`/`running`. Vem das amostras por minuto em `worker_metrics`. |

O memo explica o ganho em português, por exemplo:

> Worker pc ganhou 20,25 créditos: 10 min × 1,125 créditos/min (recursos) × desempenho 1,5 (score 1500) × disponibilidade 1,2 (100% online nas últimas 24 h).

O ganho não depende do que o dono paga. Um worker rápido ganha mais pelo mesmo trabalho, e o dono paga só recursos × tempo. A diferença sai de `issuance`, e o total emitido aparece em `/v1/credits/summary`.

## Garantias

| Ameaça | Defesa |
|---|---|
| Gasto duplo (duas requisições com o mesmo saldo) | Um escritor por vez: `pg_advisory_xact_lock`, mantido até o COMMIT. O serviço e um trigger `BEFORE INSERT` pegam o lock, então até SQL cru serializa. O saldo é conferido depois do lock, portanto em cima do que já foi confirmado. |
| Repetição ou corrida do mesmo evento | Chave de idempotência `UNIQUE`. A mesma chave com o mesmo conteúdo devolve a transação original (HTTP 200). Com outro conteúdo, dá 409. Liquidação e ganho têm chave derivada do job ou da tentativa, então rodam uma vez só. |
| Valores negativos, zero ou frações | A API aceita só créditos positivos com até 3 casas. O ledger rejeita valor 0 e fração de milicrédito. O banco tem `CHECK (amount <> 0)`. |
| Saldo negativo | Conferido pelo serviço sob o lock. Um trigger adiado confere de novo no COMMIT (só `issuance` pode ficar negativa). |
| Transação desbalanceada | Rejeitada pelo serviço e pelo trigger adiado no COMMIT (soma ≠ 0 ou menos de 2 movimentos). |
| Alteração de histórico | Triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` nas três tabelas. O `TRUNCATE` só passa com `SET LOCAL ghost.allow_ledger_truncate = 'on'`, usado apenas nos testes. |
| Adulteração com privilégio de superusuário | Cadeia de hashes: `hash = sha256(prev_hash ‖ JSON canônico da transação e dos movimentos)`. `GET /v1/credits/ledger/verify` recalcula tudo e aponta o problema. |

O verificador também confere que:

- a soma do ledger inteiro é 0;
- nenhuma carteira está negativa;
- o saldo do escrow é igual à soma das reservas abertas.

Concessões e transferências também vão para `audit_log`.

**Ordem de locks:** worker → job → assignment → ledger. Nenhum caminho pega o lock do ledger antes de um lock de job.

## Testes (`control-plane/test/credits.test.ts`)

- **Gasto duplo:**
  - 40 jobs submetidos em paralelo contra um saldo que cobre 13: exatamente 13 são criados, e o saldo nunca fica negativo;
  - 30 transferências paralelas de 3 créditos contra uma carteira de 10: exatamente 3 passam.
- **Condições de corrida:**
  - a mesma chave enviada 20 vezes em paralelo gera 1 transação e 19 repetições;
  - conclusão, cancelamento e 5 liquidações disputando o mesmo job produzem 1 reserva e 1 liquidação.
- **Valores negativos:**
  - valores negativos, zero, frações abaixo de milicrédito, strings, `null` e valores enormes são rejeitados pela API;
  - o ledger rejeita postagens desbalanceadas, sem contrapartida ou que deixariam saldo negativo;
  - SQL cru não consegue confirmar uma transação desbalanceada nem um saldo negativo.
- **Concorrência:**
  - carga mista de 4 usuários com jobs, concessões com chaves repetidas e cancelamentos, tudo em paralelo;
  - no fim todos os invariantes valem e o ledger soma 0.
- **Imutabilidade:**
  - `UPDATE`, `DELETE` e `TRUNCATE` são recusados;
  - a adulteração feita com os triggers desligados é detectada por `verify`.

## Limites conhecidos

- **Um escritor por vez no ledger.** Suficiente para uma rede privada. Se virar gargalo, dá para trocar por locks por carteira (em ordem) mais uma sequência para a cadeia de hashes.
- **O saldo é uma soma sobre os movimentos da carteira** (com índice em `wallet_id`). Não há snapshot. Se um dia precisar, será um checkpoint derivado e verificável, nunca a fonte da verdade.
- **O custo interno do scheduler é uma aproximação** ([ADR 006](006-explainable-scoring.md)): núcleos + 4 por GPU, sem RAM.
