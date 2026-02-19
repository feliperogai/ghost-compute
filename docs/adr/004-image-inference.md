# ADR 004 — Workload `image-inference`

**Status:** aceito.

Primeiro workload real: classificar um conjunto de imagens, dividido em lotes independentes que rodam em paralelo em vários workers. **Sem treinamento distribuído**: o modelo é fixo e vem embutido no agente.

## Fluxo

```
Cliente ─▶ POST /v1/datasets + /images (PNG/JPEG) + /seal
        ─▶ POST /v1/inference {datasetId, batchSize, accelerator, topK, timeoutSeconds, maxAttempts}
Control Plane: dataset → N lotes → N jobs `image-inference` (um grupo)
Scheduler: cada lote vai a um worker compatível (tipo declarado; GPU NVIDIA se pedida)
Worker: baixa as imagens do seu lote → ghost-sandbox → resultados por imagem → checkpoint
Control Plane: todos os lotes terminais → combina → GET /v1/inference/:id/result
```

## Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| Modelo | MLP 64→128→10 para dígitos 8×8 (`workloads/image-inference/model/train.py`, 97,2% no teste). Pesos embutidos no módulo WASM, fixado por SHA-256 | O cliente não envia modelos: modelo é código. Trocar de modelo = nova versão do agente |
| Decodificação | PNG/JPEG decodificados **dentro do WebAssembly** (crate `image`, limites de dimensão 4096 e 64 MB de alocação) | Parsers de imagem são a superfície de ataque clássica. Uma imagem hostil só afeta a VM WASM |
| Lotes | Imagens consecutivas; no máximo `batchSize` (1–256) e 64 MB por lote; até 2000 lotes | Lotes independentes e paralelizáveis; memória do worker limitada |
| Armazenamento | Imagens no Postgres (`bytea`, ≤ 8 MB cada, ≤ 10 000 e 1 GB por dataset). Dataset selado é imutável | Simples e transacional no MVP. Object store fica para depois |
| Entrega ao worker | `GET /v1/worker/assignments/:id/images/:index`: só o dono da atribuição, só com ela `running`, só índices do próprio lote. O agente confere tamanho e SHA-256; o sandbox confere de novo | O worker não vê o dataset inteiro, e dados trocados não passam |
| Canal agente → sandbox | Linha JSON de pedido, depois frames binários `u32 índice, u32 tamanho, bytes`, na ordem anunciada. Fila de 2 imagens | Memória do agente limitada; sem arquivos temporários |
| GPU | Só as camadas densas, num **shader WGSL fixo nosso** via wgpu (DX12 no Windows, Vulkan no Linux), rodando **no processo sandbox**. Pesos lidos da memória do módulo fixado. Preferência NVIDIA → discreta → integrada. Qualquer falha cai para CPU e o resultado diz qual foi usado | A GPU recebe só vetores de 64 floats já pré-processados. Nenhum dado do job vira código de GPU. CUDA nativo exigiria DLLs do driver e execução nativa fora do WASM |
| Quando usa GPU | `accelerator: cpu` nunca. `auto` usa se o dono compartilha GPU e existe uma. `gpu` exige worker NVIDIA com GPU compartilhada (`requirements.gpuVendor`, `resources.gpu`) e ainda cai para CPU se o dispositivo falhar | "GPU NVIDIA quando disponível" sem travar o lote |
| Saída | Por imagem: `label`, `confidenceBp` (0–10000), `topK`, ou `error` (`UNSUPPORTED_FORMAT`, `DECODE_ERROR`, `IMAGE_TOO_LARGE`). Só inteiros | O servidor verifica `sha256(JSON.stringify(output))`; floats formatam diferente em Rust e JS |
| Imagem ruim | Falha só aquela imagem; o lote segue | Um arquivo corrompido não derruba 256 |
| Progresso | O agente conta imagens concluídas e reporta a cada 2 s | Progresso real, não estimado |
| Checkpoint | Junto do progresso vai `{items: [...]}`. O servidor valida (itens do próprio lote, sem duplicatas, formato estrito) e guarda em `jobs.checkpoint`. A próxima tentativa recebe o checkpoint na oferta, revalida, e só baixa e processa o que falta. Antes de devolver um job (falha, pausa do dono), o agente envia o checkpoint final | Pausar o PC não desperdiça o trabalho feito |
| Retry | Política do ADR 002: falha retentável, worker perdido ou oferta expirada voltam à fila, até `maxAttempts`, sem repetir o worker que falhou | Mesma política de todos os jobs |
| Timeout | Por tentativa de lote (`timeoutSeconds`). Lotes têm `retry_on_timeout`: estourar o tempo reencaminha a partir do checkpoint; a última tentativa termina em `TIMEOUT` | Lote lento num PC fraco não é fim de linha |
| Combinação | Quando todos os lotes são terminais: cada imagem aparece uma vez, em ordem, com nome. Lotes não concluídos contribuem com o checkpoint; o resto vira `BATCH_FAILED`/`BATCH_TIMEOUT`/`BATCH_CANCELLED`. Itens fora do lote ou malformados são descartados. Status: `COMPLETED`, `PARTIAL`, `FAILED` ou `CANCELLED`. Resultado guardado em coluna `json` (bytes preservados) com `resultSha256` | Um worker mentiroso não injeta resultado em lote alheio; o cliente pode verificar o resultado |

## Isolamento (complementa o ADR 003)

- Mesmo registro fechado: `image-inference` só aceita manifesto de imagens (`index`, `sha256`, `size`), `accelerator` e `topK`. Campos extras são recusados nos dois lados. `POST /v1/jobs` recusa esse tipo: ele só nasce pelo `/v1/inference`.
- Upload: só `image/png` e `image/jpeg`, e os bytes precisam bater com o tipo declarado (magic bytes). Executáveis, scripts, GIF, JSON e multipart são recusados.
- Wasmtime com `memory_init_cow(false)`: nada é escrito em arquivo nem em memfd pelo runtime.
- Modo GPU no Unix: drivers Mesa alocam memória em memfd, que o `RLIMIT_FSIZE` também limita. Nesse modo o limite vira o teto de memória do processo e o cache de shaders em disco é desligado (`MESA_SHADER_CACHE_DISABLE`). O processo ganha 4 GB extras de espaço de endereçamento para o driver. No Windows o Job Object continua igual.
- O dono decide: sem `max_gpu_percent > 0`, o sandbox nunca abre a GPU.

## API

| Método | Rota | Papel |
|---|---|---|
| POST | `/v1/datasets` `{name}` | operator |
| POST | `/v1/datasets/:id/images?name=` (corpo = bytes, `content-type: image/png\|image/jpeg`) | dono |
| POST | `/v1/datasets/:id/seal` | dono |
| GET | `/v1/datasets` · `/v1/datasets/:id` | dono ou admin |
| POST | `/v1/inference` | operator, dono do dataset |
| GET | `/v1/inference` · `/v1/inference/:id` (status, progresso, lotes por estado) | dono ou admin |
| GET | `/v1/inference/:id/result` | dono ou admin; 409 enquanto roda |
| POST | `/v1/inference/:id/cancel` | dono ou admin |
| GET | `/v1/worker/assignments/:id/images/:index` | worker da atribuição |
| POST | `/v1/worker/assignments/:id/progress` `{progress, stage?, checkpoint?}` | worker |

## Testes

- Módulo: acurácia no conjunto de teste, 24 PNG/JPEG, bombas de descompressão, não-imagens.
- Sandbox real (`agent/tests/inference.rs`): CPU, GPU (Mesa lavapipe no Linux) com os mesmos rótulos da CPU, GPU desligada pelo dono, imagens hostis falhando uma a uma, frames trocados, índice fora do lote, entrada interrompida, retomada parcial, memória e prazo.
- Executor (`agent/tests/executor.rs`): retomada do checkpoint baixando só o que falta; imagem adulterada no servidor falha a tentativa e salva o checkpoint.
- Control Plane (`test/inference.test.ts`): uploads hostis, privacidade, divisão em lotes, roteamento para NVIDIA, fluxo completo com falha, checkpoint, retry, worker mentiroso, timeout com retomada, cancelamento, agregação.
- Ponta a ponta (`agent/scripts/e2e-local.sh`): 24 imagens reais, 5 lotes, agente e sandbox reais, 24/24 corretas e hash do resultado conferido.

## Limites conhecidos

- Modelo único e pequeno (dígitos 8×8). A estrutura (registro, lotes, checkpoint, GPU mediada) serve para modelos maiores; cada um entra como novo tipo ou nova versão fixada.
- Sem NVIDIA real neste ambiente: o caminho GPU foi validado com Vulkan por software (lavapipe) e compila para DX12. Em Windows com GPU o fallback para CPU cobre falhas do driver dentro do Job Object.
- Imagens no Postgres limitam o tamanho prático dos datasets.
