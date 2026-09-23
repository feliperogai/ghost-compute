# ADR 005 — Benchmark automático dos Workers (WorkerPerformanceProfile)

**Status:** aceito.

## Problema

"Tem GPU" não diz quanto o worker rende. Um lote de inferência pode ir para uma GPU lenta, um driver quebrado ou um PC com rede ruim. O scheduler precisa de números medidos.

## Decisão

Quando um worker entra na rede, o Control Plane pede uma **calibração**: benchmarks controlados, executados pelo próprio agente com o mesmo isolamento dos jobs. O resultado vira um `WorkerPerformanceProfile`, e o scheduler escolhe workers por ele.

```
heartbeat ──▶ servidor: precisa calibrar? (primeira vez, hardware mudou, agente mudou, perfil > 7 dias)
          ◀── calibration {id, nonce, params}
agente (ocioso, compartilhando): CPU → inferência CPU/GPU → GPU matmul → disco → rede
          ──▶ /calibration/:id/report ──▶ servidor verifica → perfil → scheduler
jobs reais ──▶ throughput observado (EWMA) corrige o benchmark
```

## O que é medido e como

| Medida | Como | Prova |
|---|---|---|
| **CPU** | 3 testes do módulo `benchmark` (hash, matmul, primos) no sandbox; depois N sandboxes em paralelo (N ≤ núcleos que o dono oferece) | Checksums fixos, conhecidos pelo servidor |
| **Inferência** | `image-inference` sobre 24 dígitos embutidos no agente, repetidos até N imagens; CPU e, se o dono compartilha GPU, GPU. Mede startup, itens/s e latência por item | Rótulos conhecidos: CPU tem que acertar 100%; GPU ≥ 95% |
| **GPU** | Shader WGSL fixo de multiplicação de matrizes (n = 512), repetido até ~0,3 s, no processo sandbox. Mais nome e fabricante da GPU | Entradas são inteiros pequenos, exatos em f32: o checksum é exato em qualquer GPU |
| **VRAM** | Total do inventário (DXGI/sysfs) menos uso atual do sampler | — |
| **RAM** | Total, disponível agora, oferecida pelo dono | — |
| **Latência** | N pings autenticados ao Control Plane (mediana, p95) | — |
| **Banda** | Download e upload de 8 MB gerados por SHA-256 em modo contador sobre um nonce | Download: hash conferido. Upload: **medido pelo servidor** e bytes conferidos |
| **Disco** | Arquivo de 64 MB no diretório privado do agente: escrita com `fsync`, leitura, 16 escritas pequenas com `fsync` | — |

## O perfil

```json
{
  "gpu": { "name": "NVIDIA GeForce RTX 4070", "vramTotalMb": 12282, "vramAvailableMb": 11000, "matmulGflops": 20000, "verified": true },
  "inference": { "cpu": { "itemsPerSec": 3800 }, "gpu": { "itemsPerSec": 8000, "avgLatencyMs": 0.1 }, "best": "gpu" },
  "network": { "latencyMs": { "median": 21, "p95": 22 }, "downloadMbps": 100, "uploadMbps": 50 },
  "scores": { "cpu": 1000, "gpu": 20000, "inference": 16000, "network": 1000, "storage": 1000, "overall": ... }
}
```

`GET /v1/workers/:id/profile` devolve o perfil, um resumo (GPU, VRAM, score de inferência, latência média, throughput), o observado em jobs reais e o histórico de calibrações. Scores: **1000 = máquina de referência** (constantes em `performance/profile.ts`).

## Como o scheduler usa

1. **Elegibilidade**:
   - Job de GPU exige GPU **calibrada e verificada** (`GPU_NOT_CALIBRATED`, `GPU_UNVERIFIED`).
   - "NVIDIA" é conferido pelo dispositivo que rodou o shader.
   - `minVramMb` é conferido contra a VRAM livre medida.
   - Se a estimativa passa do timeout, o worker não recebe o lote (`TOO_SLOW`).
2. **Estimativa de tempo**: `startup + max(itens / throughput, itens × latência + bytes / banda)`.
   - Download e cálculo se sobrepõem, então o mais lento dita o ritmo.
   - Lote preso na rede não ganha nada com GPU; o modelo mostra isso.
3. **Score**: novo componente `performance` (peso 0,4), com `vazão / (vazão + referência)`.
   - Worker sem perfil verificado fica em 0,25: abaixo da referência, mas ainda elegível para jobs de CPU.
   - Job `auto` que vai usar a GPU daquele worker não é penalizado por "ocupar GPU".
4. **Realidade vence benchmark**:
   - Cada lote concluído atualiza uma EWMA de itens/s, descontado o startup medido.
   - Com 3 amostras ou mais, ela substitui o benchmark.
   - Um worker que mentiu na calibração perde a vantagem logo nos primeiros jobs.

## Segurança e o dono

- **Só roda quando o dono está compartilhando** e nada mais está em execução. Durante a calibração o agente recusa jobs (os números ficam limpos).
- A calibração aparece no app como workload ativo. Pausar ou parar interrompe na hora.
- O servidor só escolhe **tamanhos**, com limites no agente:
  - até 4 testes de CPU;
  - até 512 imagens;
  - matriz ≤ 1024;
  - até 32 MB de rede;
  - até 256 MB de disco;
  - pedido fora disso é recusado inteiro.
- Não escolhe código, caminho nem host:
  - CPU, inferência e GPU rodam no `ghost-sandbox`;
  - o disco usa um arquivo fixo no diretório privado, apagado ao fim, e só se houver 4× o espaço livre;
  - a rede só fala com o próprio Control Plane.
- O tipo interno `gpu-probe` não vem da rede. `Workload::parse` recusa esse tipo; só `parse_local`, usado pelo sandbox, aceita.
- Sem GPU compartilhada pelo dono, nenhum teste abre a GPU.

## Verificação e limites honestos

- Checksums e rótulos detectam hardware ou driver com defeito e execução incorreta. Não impedem um agente **modificado** de inventar tempos, porque os valores esperados são públicos.
- Contra isso, dois mecanismos:
  - o upload é cronometrado pelo servidor;
  - o throughput observado em jobs reais (medido pelo servidor, do aceite ao resultado) substitui o benchmark.
- Relatório que falha a verificação de CPU fica com `verified: false`. O worker é tratado como não calibrado, e o servidor espera 30 min para pedir de novo.
- O cache do SO pode inflar a leitura de disco. O valor é reportado como medido.

## Reprodutibilidade

- Vetores compartilhados entre TypeScript e Rust:
  - stream de rede (`ghost-test-vector`);
  - checksum da matmul (n = 64 → −920; n = 512 → 213);
  - checksums de CPU;
  - rótulos de calibração.
- Montagem do perfil (`buildProfile`) e escolha do scheduler são funções puras e determinísticas.
- Testes com relatórios sintéticos e frota fixa: GPU rápida, GPU lenta, GPU quebrada, CPU rápida, CPU lenta, sem perfil.
- Agente: sandbox real com a sonda GPU (lavapipe) e calibração completa contra servidor mock.
- `agent/scripts/e2e-local.sh`: o worker entra, calibra, o perfil sai verificado, e os lotes reais alimentam o observado.
