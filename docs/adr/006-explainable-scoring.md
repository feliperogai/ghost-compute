# ADR 006 — Scheduler com score explicável

**Status:** aceito. Substitui o score ponderado do ADR 002 como estratégia padrão (`SCHEDULER_STRATEGY=score`; `weighted` continua registrado).

## Fórmula

```
worker_score = performance + availability + reliability + resource_fit − latency − current_load
```

Cada termo vale de 0 a 1 e é multiplicado por um peso. Sem aprendizado de máquina e sem aleatoriedade. Empates são decididos pelo id do worker. A mesma fila e os mesmos workers produzem sempre a mesma escolha e o mesmo texto de explicação.

| Termo | Sinal | O que entra | Considera |
|---|---|---|---|
| `performance` | + | Vazão estimada para este job: observada em jobs reais (≥ 3 amostras), senão a calibração ([ADR 005](005-worker-calibration.md)). Inclui computação, transferência e latência por item. Jobs sem tamanho usam o score de CPU. Sem perfil: 0,25 | performance histórica |
| `availability` | + | 50% heartbeat recente, 50% tempo online sem interrupção (cheio após 1 h) | disponibilidade |
| `reliability` | + | (concluídos + 1) / (tentativas + 2) nas últimas 50 tentativas; falha, perda, expiração e timeout contam como falha | taxa de falha |
| `resource_fit` | + | 40% folga de CPU/RAM após alocar, 30% encaixe de GPU, 30% custo interno | requisitos, custo interno |
| `latency` | − | latência medida / (latência + 100 ms). Jobs sem transferência de dados pesam 30% disso | latência |
| `current_load` | − | 40% uso de CPU pelo dono, 30% vagas ocupadas, 30% temperatura (de 30 °C até o limite do dono) | utilização, temperatura |

- **Encaixe de GPU:**
  - Job que exige GPU: folga de VRAM.
  - Job que só usaria GPU por oportunidade (`auto`) ou job de CPU: máquina com GPU vale 0,5, porque a GPU é escassa. O termo `performance` compensa quando a GPU é muito mais rápida.
- **Custo interno:** minutos estimados × créditos/minuto, contando 1 por núcleo reservado e mais 4 se usar GPU. Os créditos são internos, sem dinheiro. Eficiência = 1 / (1 + custo).
- **Requisitos do job:**
  - Continuam sendo **restrições rígidas** antes do score: tipo, SO, instruções de CPU, RAM, GPU calibrada, VRAM, disco, temperatura, vagas.
  - `TOO_SLOW` também é restrição: a estimativa de tempo não pode passar do timeout.
  - Nada disso é compensado por score.

## Prioridade

A prioridade decide a ordem da fila e também os pesos:

| Faixa | performance | availability | reliability | resource_fit | latency | current_load |
|---|---|---|---|---|---|---|
| alta (≥ 70) | 0,40 | 0,15 | 0,20 | 0,05 | 0,10 | 0,10 |
| normal | 0,30 | 0,15 | 0,20 | 0,15 | 0,10 | 0,10 |
| baixa (< 30) | 0,20 | 0,10 | 0,20 | 0,30 | 0,10 | 0,10 |

- **Alta:** o job urgente vai para a máquina mais rápida.
- **Baixa:** o job de fundo vai para a que encaixa melhor e custa menos, deixando GPUs livres.

## Registro de cada decisão

Toda alocação grava uma linha em `scheduler_decisions`, na mesma transação da atribuição, com:

- `summary`: o texto "Worker X foi escolhido porque ...". Traz os 3 termos que mais o separaram do segundo colocado, com os números, o score contra o segundo colocado e a margem, quantos workers foram descartados e por quê, e a faixa de prioridade.
- `explanation`:
  - fórmula e pesos usados;
  - todos os termos do escolhido, cada um com valor, peso, contribuição e dados brutos (latência em ms, °C, concluídos/falhas, segundos estimados, créditos);
  - segundo colocado, top 5 candidatos e contagem de descartes por motivo.

Exemplo:

> Worker escritorio-01 (a1b2c3d4) foi escolhido porque mais confiável (18 concluídos, 1 falha recente vs 4/6); desempenho medido melhor (0,37; lote estimado em 1,09 s vs 1,34 s, fonte: benchmark); menor latência (8 ms vs 12 ms). Score 0,553 contra 0,437 de lab-03 (c9d0e1f2) (margem 0,116). 1 worker(s) descartado(s): 1× temperatura perto do limite. Prioridade 60 (normal).

API:

- `GET /v1/jobs/:id` traz `placementReason`, a decisão mais recente.
- `GET /v1/jobs/:id/decisions` traz o histórico, uma decisão por tentativa.
- O evento `job.assigned` leva o `reason`.

Job que não pôde ser alocado continua com `pendingReason`, por exemplo "no eligible worker (2× TOO_HOT, …)".

## Testes

`control-plane/test/scheduler-score.test.ts`:

- a fórmula: soma dos termos, sinais, faixas de 0 a 1;
- cada fator muda a decisão com o resto igual: desempenho medido, desempenho observado, heartbeat, tempo online, falhas, latência, CPU do dono, temperatura, vagas, GPU;
- a prioridade inverte a escolha entre GPU rápida e CPU barata;
- determinismo: mesma entrada em qualquer ordem dá resultado e texto idênticos;
- conteúdo da explicação.
