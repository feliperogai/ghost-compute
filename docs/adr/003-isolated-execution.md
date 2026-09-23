# ADR 003 — Execução isolada de Jobs

**Status:** aceito (MVP).

## Requisito

Um Job recebido pela rede **nunca** executa comandos, scripts ou binários no Windows do voluntário. Ele roda isolado, com limites que o dono controla.

## Opções avaliadas

| Opção | Isolamento | Requisitos no PC do voluntário | Início | Veredito |
|---|---|---|---|---|
| Containers Windows (process isolation) | Médio: kernel compartilhado | Docker ou containerd; imagens de GBs | Segundos | Não. Pesado demais e isolamento fraco sem Hyper-V |
| Containers com Hyper-V isolation | Alto | Windows Pro/Enterprise e Hyper-V | Segundos | Não. Exclui Windows Home |
| Windows Sandbox | Muito alto (VM) | Pro/Enterprise; uma instância por vez; sem API estável | ~10 s | Não. Sem automação confiável |
| Hyper-V / microVM | Muito alto | Pro, virtualização ligada, imagem de SO | Segundos | Adiado para workloads de GPU |
| Processo restrito puro (AppContainer, token restrito) | Médio: roda código nativo | Nenhum | ms | Não. Executaria código nativo, proibido |
| **WebAssembly (Wasmtime) em processo sandbox + Job Object** | **Alto** | **Nenhum (inclui Home)** | **ms** | **Escolhido** |

## Decisão: três camadas

```
Rede ─▶ agente ─(tipo + parâmetros validados)─▶ ghost-sandbox.exe ─▶ Wasmtime ─▶ módulo embutido
         │                                        │                   │
   1. registro fechado                      2. processo confinado  3. VM de bytecode sem syscalls
```

1. **Registro fechado de tipos.** O job carrega só `type` e parâmetros JSON. O código de cada tipo é um módulo WebAssembly **compilado dentro do binário**, com SHA-256 fixado no código (`agent/src/execution/registry.rs`). Parâmetros são validados com schema estrito dos dois lados: servidor (`control-plane/src/jobs/workloads.ts`) e agente. Campos desconhecidos são recusados. Não existe caminho para a rede entregar código.
2. **Processo sandbox descartável** (`ghost-sandbox`), um por job. Ambiente vazio, diretório de trabalho privado e vazio, só stdin/stdout, e limites do SO aplicados **antes** de ele receber a requisição.
3. **WebAssembly sem WASI.** O módulo só calcula. A única função do host que ele enxerga é `ghost.progress(f32)`.

## Respostas por aspecto

| Aspecto | Como funciona |
|---|---|
| **Nível de isolamento** | O módulo não tem syscalls, ponteiros para fora da própria memória, threads, relógio, aleatoriedade do SO nem ambiente. Um escape exigiria bug no Wasmtime **e** vencer o confinamento do processo. |
| **Rede** | Nenhuma. Não existe import de socket; qualquer import além de `ghost.progress` recusa o módulo. O processo sandbox não recebe credenciais, e o canal é só stdin/stdout. |
| **Filesystem** | Nenhum acesso pelo módulo (sem WASI). O processo roda num diretório vazio, privado (0700 no Unix) e apagado ao final. No Unix, `RLIMIT_FSIZE=0` impede criar arquivos com conteúdo. |
| **GPU** | Nenhuma no MVP. O tipo `benchmark` declara `supportsGpu: false` e o servidor recusa `resources.gpu`. GPU ficará para uma fase com Hyper-V/GPU-PV ou compute mediado pelo host. |
| **CPU** | O job pede núcleos. O agente limita ao máximo do dono. Windows: Job Object com `CPU_RATE_CONTROL_HARD_CAP` (% da máquina) e prioridade IDLE. Unix: `RLIMIT_CPU`. O workload atual é single-thread. |
| **RAM** | Duas travas. A memória linear do WASM é limitada (`StoreLimits`, sem crescimento além do teto). O processo inteiro é limitado: Windows Job Object `ProcessMemoryLimit`; Unix `RLIMIT_AS`. O teto é o menor entre o que o job pede e o máximo do dono, mais 256 MB de overhead do runtime. |
| **Tempo** | Três travas: deadline por epoch dentro do Wasmtime (o guest não consegue bloquear), kill pelo agente ao passar do deadline mais 2 s, e timeout do job no servidor (estado `TIMEOUT`). |
| **Destruição do ambiente** | Ao final, com sucesso, erro, cancelamento ou pausa: kill do processo (Windows: `TerminateJobObject` + `KILL_ON_JOB_CLOSE`; também `kill_on_drop`), reap e remoção do diretório. Na inicialização, o agente apaga resíduos de execuções anteriores. |
| **Interrupção pelo dono** | Pausar, parar ou violar um limite (calor, bateria, uso do dono) mata o sandbox na hora. O servidor recebe `failed, retryable` e reencaminha o job. |
| **Tratamento de escape** | Defesa em profundidade, e cada camada falha fechada. Se um limite do Job Object não pode ser aplicado, o job não roda (verificado no Wine, que não implementa o teto de CPU). Módulo com hash diferente é recusado. Imports proibidos, traps, estouro de pilha ou memória viram falha do job, nunca do agente. Um escape bem-sucedido ainda cairia num processo com 1 processo ativo (sem filhos), sem janela nem clipboard, com memória e CPU limitadas, e sem credenciais. |
| **Atualização** | Módulos só mudam com nova versão do agente (binário assinado, updater em fase futura). O hash fixado obriga uma mudança deliberada: `workloads/build.sh` imprime o hash novo, que precisa ser atualizado no registro. Wasmtime atualizado via dependência. |
| **Logs** | O agente registra início, limites aplicados (CPU %, MB), fim, motivo e hash do módulo. A saída do sandbox é protocolo estruturado com tamanho limitado (64 KB por linha, 4 MB no total); stderr é descartado. O servidor guarda eventos por tentativa (`job_events`). |

## Workload `benchmark`

```json
{ "type": "benchmark", "input": { "kind": "hash" | "primes" | "matmul", "size": 0, "iterations": 1, "seed": 0 } }
```

| kind | O que faz | Limites |
|---|---|---|
| `hash` | SHA-256 encadeado | `iterations` ≤ 5×10⁷; `size` não é usado |
| `primes` | Crivo segmentado, conta primos ≤ `size` | `size` de 2 a 5×10⁷ |
| `matmul` | Produto de matrizes `size`×`size` em f64 | `size` ≤ 256, `iterations` ≤ 1000 |

A saída é determinística (checksum), mais o tempo medido pelo host:

```json
{ "checksum": "00000000000132a2", "elapsedMs": 235, "opsPerSecond": 8518517,
  "runtime": { "engine": "wasmtime", "moduleSha256": "e1edf2…" } }
```

## Testes de violação

| Camada | Arquivo | O que tenta |
|---|---|---|
| Servidor | `control-plane/test/jobs.test.ts` | Tipos `shell`, `powershell`, `script`, `exe`, `wasm`; campos `command`/`path`/`module` escondidos nos parâmetros; valores fora de faixa; `command`/`executable` no topo do job; GPU num tipo que não a suporta |
| Registro do agente | `agent/src/execution/registry.rs` | Os mesmos, mais variações de nome de tipo |
| Módulos WASM hostis | `agent/tests/wasm_escape.rs` | WASI (arquivos, rede, processos, ambiente, relógio), imports `kernel32`/`env`, memória e tabela do host, loop infinito, bomba de memória, estouro de pilha, acesso fora dos limites, memória compartilhada, PE/script no lugar de módulo |
| Processo sandbox | `agent/tests/sandbox_process.rs` | Requisições cruas com comandos, scripts, executáveis e módulo embutido; JSON inválido ou gigante; deadline; cancelamento; limite de memória do WASM e do SO; limpeza do diretório |
| Executor | `agent/tests/executor.rs` | 8 atribuições hostis "vindas da rede": todas recusadas, nenhuma aceita ou executada; pausa do dono mata e reencaminha; cancelamento do servidor |
| Ponta a ponta | `agent/scripts/e2e-local.sh` | Job real executado no sandbox e verificado; job `shell` recusado; diretório do sandbox vazio |

## Limitações conhecidas (próximos passos)

- **AppContainer / token de baixa integridade** para o processo sandbox ainda não estão implementados. Hoje o sandbox roda com o token da conta do serviço, confinado por Job Object. É a próxima camada a adicionar.
- **Teto de CPU e de memória do Job Object só são verificados no Windows real (CI).** No Wine, o teto de CPU não existe (o código falha fechado, comprovado) e o de memória não é aplicado.
- **Linux só serve para desenvolvimento:** rlimits e `no_new_privs`, sem seccomp.
- Módulos são embutidos. Distribuir módulos novos sem atualizar o agente exigirá assinatura Ed25519 dos módulos, conforme a arquitetura.
