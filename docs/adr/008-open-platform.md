# ADR 008 — Plataforma aberta: provedores, clientes, matching e reputação objetiva

**Status:** aceito. Troca a regra "rede privada, sem marketplace" por uma plataforma aberta. Não muda estas regras:

- créditos **virtuais**: sem dinheiro, compra, venda ou saque em moeda;
- nenhuma execução arbitrária: só workloads registrados, validados e em sandbox;
- o dono do computador pausa ou para na hora, no próprio agente.

## Papéis

| Papel | Quem | Vê |
|---|---|---|
| `member` | Qualquer pessoa, via `POST /v1/signup`. Pode ser cliente, provedor ou os dois. | Só os próprios jobs, computadores e créditos. Um id de outra pessoa responde 404. Não tem painel, WebSocket global, lista de workers nem ledger. |
| `viewer` / `operator` / `admin` | Equipe da plataforma | Tudo, como antes. |

- **Cadastro:**
  - `OPEN_SIGNUP` liga ou desliga o cadastro público;
  - `SIGNUP_PER_IP_PER_HOUR` limita cadastros por IP;
  - `SIGNUP_CREDITS` define o crédito de boas-vindas (padrão 100, menor que o da equipe, porque contas públicas são grátis de criar).

## Provedores

| O quê | Como |
|---|---|
| Registrar computadores | `POST /v1/provider/enrollment-tokens` gera um token de uso único (máximo de 10 abertos). O computador registrado com ele pertence a quem gerou o token. |
| Disponibilidade | Janelas semanais no fuso do provedor: `{timezone, windows:[{days, start, end}]}`. Janela vazia = sempre. Uma janela com fim antes do início atravessa a meia-noite. A **tentativa inteira** precisa caber na janela atual: um job de 1 h não começa faltando 30 min para o fim. |
| Preço | Créditos por minuto de cada recurso reservado: `cpuCore`, `ramGb`, `gpu`, `vramGb`. Cada valor vai de 0 a 100× o preço padrão, e não pode ser tudo zero. |
| Limites | `maxCpuCores`, `maxRamMb`, `maxJobSeconds`, `maxConcurrent`, `allowGpu`, `workloadTypes`. Somam-se aos limites locais do agente (CPU, RAM, temperatura, horário, jogos), que continuam mandando. |
| Receber créditos | Na liquidação de cada job concluído, o provedor recebe o seu preço × o tempo que o computador trabalhou. Depois, `POST /v1/credits/workers/:id/withdraw` transfere os créditos para a carteira do dono. |

- **Onde se define:** `PUT /v1/provider/workers/:id/offer` aceita atualização parcial.
- **Mudança de preço:** o preço é fotografado em `job_assignments.price_rate` no momento da alocação. Mudar o preço depois não afeta tentativas já alocadas.
- **Auditoria:** cada alteração vai para `audit_log` (antes e depois).

## Clientes

| O quê | Como |
|---|---|
| Criar jobs | `POST /v1/jobs`, com os mesmos tipos registrados de antes. `POST /v1/inference` também está aberto a membros. |
| Requisitos | Os de sempre (SO, instruções de CPU, RAM, GPU, VRAM), mais `minReputation` (0–1000). |
| Orçamento | `budget` em créditos: o máximo que o job pode custar, reservado na criação. Sem orçamento: preço padrão × timeout. Na inferência: × `maxAttempts` por lote, porque lotes retomados pagam cada tentativa. |
| Acompanhar | `GET /v1/jobs/:id` (estado, progresso, motivo da alocação ou da espera, orçamento), `/events`, `/decisions`, `GET /v1/credits/spending`. |
| Comparar antes | `GET /v1/market/offers` lista o mercado. `POST /v1/market/quote` diz quem aceitaria o job e quanto custaria no máximo, com as mesmas regras do scheduler, sem criar nada. |

## Matching

**Restrições rígidas.** Um worker que falha em qualquer uma é descartado, sem compensação pelo score:

- capacidades × requisitos (como antes);
- `NOT_LISTED`: fora do mercado;
- `PROVIDER_LIMITS`: fora dos limites do provedor;
- `OUTSIDE_AVAILABILITY`: fora da janela de disponibilidade;
- `OVER_BUDGET`: `ceil(preço × timeout / 60)` passa do orçamento restante. Assim nenhuma tentativa pode custar mais que o orçamento;
- `LOW_REPUTATION`: reputação abaixo de `minReputation`.

A alocação confere de novo, dentro da transação, o preço atual e o orçamento. Isso fecha a corrida em que o provedor sobe o preço entre o snapshot e a alocação.

**Score.** A fórmula do [ADR 006](006-explainable-scoring.md) continua a mesma, e dois termos passam a usar dados do mercado:

- `reliability` = reputação ÷ 1000. Sem reputação calculada, usa a taxa de falha recente, como antes.
- `resource_fit` = 0,35 × folga + 0,15 × encaixe de GPU + 0,5 × eficiência de preço.
  - Com duração estimada: 1 / (1 + custo estimado em créditos).
  - Sem estimativa: preço padrão / (padrão + preço do provedor). Igual ao padrão dá 0,5; metade do preço, 0,67; o dobro, 0,33.

A explicação cita preço e reputação com números, por exemplo:

> Worker cheap foi escolhido porque melhor preço e encaixe (0,63 créditos/min vs 1,63 créditos/min …)

> … reputação maior (812 vs 540; 30 jobs concluídos, falhas 0%, uptime 98%, resposta 2 s)

## Pagamento

Tudo no mesmo ledger imutável do [ADR 007](007-internal-credits.md).

- **Criação:** `hold` (cliente → escrow) do orçamento.
- **Job concluído:** uma única `settlement`:
  - escrow → cada provedor: Σ, por tentativa produtiva, de `min(ceil(price_rate × ceil(s) / 60), ceil(price_rate × timeout / 60))`;
  - escrow → cliente: a sobra;
  - o total nunca passa do que foi reservado.
- **Falha, timeout ou cancelamento:** devolução integral. Provedor que falhou não recebe.
- **Tentativa produtiva:** a que concluiu, ou um timeout retomável cujo checkpoint foi aproveitado.

## Reputação: só métricas objetivas

Vem de `src/market/reputation.ts`, é pura e determinística e fica em cache de 30 s no scheduler.

```
score = 1000 × (0,40 confiabilidade + 0,25 uptime + 0,15 resposta + 0,20 experiência)
```

| Métrica | Fonte (sempre registro do servidor) | Componente |
|---|---|---|
| Jobs concluídos | Tentativas `completed` nos últimos 30 dias | experiência = log10(1 + n) / log10(1001) |
| Taxa de falha | `failed`, `timeout`, `lost`, `expired` sobre as tentativas encerradas em 30 dias | confiabilidade = (concluídos + 1) / (tentativas + 2) |
| Uptime | Minutos em `available`/`running` nas amostras de heartbeat dos últimos 7 dias (ou desde o cadastro) | fração 0–1 |
| Tempo médio de resposta | `started_at − assigned_at`: relógio do servidor na oferta e no aceite | 10 / (10 + segundos) |

Por que isso não é manipulável:

- **Não existe avaliação, nota, review, like nem comentário.** Nenhuma rota recebe isso, e há teste para essas rotas e para campos extras na oferta.
- **O worker não informa nada que entre na reputação.** Campos extras no heartbeat são descartados pelo schema. Contadores e tempos são do servidor.
- **Jobs do próprio dono não contam.** Um provedor que manda jobs para o próprio computador não ganha reputação (há teste).
- **O que não é reputação fica fora:** o nome do provedor, o preço e o texto da oferta não entram na conta.
- **Mesmo cálculo para todos:** a mesma reputação aparece na listagem, na cotação e na decisão do scheduler.

## Limites conhecidos (não resolvidos aqui)

- **Resultado errado com hash coerente.** O hash só prova que o resultado não mudou no caminho, não que está certo. Os workloads são determinísticos, então o próximo passo natural é verificação por redundância: executar parte dos jobs em dois provedores e comparar. Até lá, um provedor mal-intencionado pode devolver lixo. A reputação só pega quem falha, não quem mente.
- **Várias contas do mesmo provedor** ainda podem simular clientes e inflar a reputação. O cadastro limitado por IP e o crédito inicial pequeno só encarecem isso.
- **Privacidade dos inputs.** O provedor vê o input dos jobs que executa. Clientes não devem enviar dados sensíveis.
- **Um cliente pode desistir perto do fim.** Cancelar um job em execução devolve o orçamento inteiro, e o provedor não recebe.
- **GPU em modo `auto`** não é cobrada, porque o preço usa os recursos reservados. O provedor que não quer ceder a GPU usa `allowGpu: false`, e isso também bloqueia jobs `auto` em máquinas com GPU.
- **WebSocket só para a equipe.** O stream é global; membros acompanham por REST.
