# ghost dashboard

Painel web de administração e observabilidade da rede. React + Vite, sem biblioteca de gráficos: os gráficos são SVG próprios.

## Rodar

```bash
npm ci
npm run build            # dist/ → o control plane serve em /dashboard/
npm run dev              # Vite em :5180, com proxy de /v1 para GHOST_API (padrão http://127.0.0.1:8080)
npm test
```

Entre com um token de API de papel `viewer` ou acima. O token fica só na aba (`sessionStorage`) e vai em cada requisição.

Para ver o painel com dados sem máquinas reais, use um banco de desenvolvimento **vazio**:

```bash
cd ../control-plane
DATABASE_URL=postgres://…/ghost_demo npx tsx scripts/seed-demo.ts   # 5 workers, 24 h de histórico
```

## Páginas

| Página | Conteúdo |
|---|---|
| Visão geral | **Rede:** workers online/offline, CPU, GPU, RAM, VRAM (oferecido vs instalado). **Jobs:** na fila, executando, concluídos, falhas. **Sistema:** erros 5xx, falhas de tentativa, latência da API (p50/p95/p99), throughput. Histórico de 1 h a 7 d, motivos de fila, erros recentes, eventos ao vivo |
| Workers | Tabela com busca e filtro: hardware, performance (calibração), temperatura, utilização (CPU total e ghost), RAM, GPU, jobs ativos, uptime, heartbeat, sucesso/falha em 24 h |
| Worker | Todas as métricas do computador: blocos de resumo, histórico (CPU total/ghost, RAM, GPU, temperatura média/máx., jobs, tempo compartilhando), perfil de calibração e histórico de calibrações, tentativas com erro, decisões do scheduler ("foi escolhido porque…"), erros, eventos de jobs, eventos ao vivo filtrados, dados brutos |
| Erros | Erros da API (com request id para achar nos logs), tentativas que falharam e calibrações reprovadas, filtráveis |

## Gráficos

- Um eixo por gráfico.
- Linhas de 2px; grade fina.
- Crosshair com tooltip que lista todas as séries; também navegável pelo teclado (setas).
- Legenda quando há duas ou mais séries.
- Tabela ("Ver tabela") com todos os valores.
- Lacunas nos dados aparecem como lacunas, não como zero.
- Cores: as três primeiras da paleta de referência, validadas em claro e escuro.
- Estados sempre com ícone e texto, nunca só com cor.
