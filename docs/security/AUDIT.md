# Auditoria de segurança — plataforma aberta

**Data:** 2026-09-24.

**Escopo:** control plane (API, scheduler, créditos, mercado), agente Windows/Linux (sandbox, GPU, credenciais, rede), apps desktop e dashboard, CI e dependências.

**Método:** leitura do código de cada camada, modelagem por atacante (worker, provedor, cliente, externo) e verificação por teste automatizado de cada controle.

Severidade = impacto × probabilidade:

| | Probabilidade baixa | média | alta |
|---|---|---|---|
| **Impacto alto** | Médio | Alto | Crítico |
| **médio** | Baixo | Médio | Alto |
| **baixo** | Baixo | Baixo | Médio |

"Antes" é o estado encontrado no início da auditoria. "Depois" é o risco residual com os controles implementados. Cada controle aponta para o teste que o prova.

## Resumo

| # | Ameaça | Antes | Depois | Controles novos |
|---|---|---|---|---|
| 1 | Worker comprometido | Alto | Médio | revogação pelo próprio provedor, verificação por réplica |
| 2 | Job malicioso | Médio | Baixo | (já havia) tipos registrados, schemas estritos; + filtro de syscalls |
| 3 | Provedor malicioso | **Crítico** | Médio | réplicas de donos e redes diferentes, desempate, verificador confiável, teto de cobrança, segunda opinião |
| 4 | Cliente malicioso | Alto | Baixo | cobrança por cancelamento, reputação só culpa o worker, cotas |
| 5 | Fuga do sandbox | Alto | Médio | seccomp (Linux), políticas de mitigação (Windows) |
| 6 | Roubo de credenciais | Alto | Médio | tokens públicos expiram, rotação/revogação, revogação de computador |
| 7 | Man-in-the-middle | Médio | Baixo | `REQUIRE_TLS` + HSTS, confiança explícita no proxy |
| 8 | Replay | Médio | Baixo | (já havia) idempotência; + testes de replay |
| 9 | Abuso de API | **Crítico** | Baixo | `TRUST_PROXY`, rate limit global por credencial/IP (inclusive 404) |
| 10 | DDoS | Alto | Médio | rate limit global, timeouts de requisição/conexão/keep-alive |
| 11 | Exaustão de recursos | Alto | Baixo | cotas por conta (jobs, datasets, bytes) |
| 12 | Vazamento de dados | Alto | Médio | réplicas isoladas, headers, ids de requisição saneados |
| 13 | Vazamento de memória de GPU | Médio | Baixo | teste de buffers zerados; processo e device por job |
| 14 | Acesso ao filesystem | Médio | Baixo | + seccomp e políticas de imagem no Windows |
| 15 | Abuso de rede | Médio | Baixo | + sockets de rede negados no sandbox |
| 16 | Supply chain | Alto | Médio | auditoria de dependências no CI, Dependabot, token de CI só leitura, remoção de crate sem manutenção |

Os dois riscos **críticos** encontrados (3 e 9) estão mitigados e testados. Os riscos residuais estão na seção final, junto com as condições para abrir a usuários externos.

---

## 1. Worker comprometido

- **Risco:** a máquina de um provedor, ou o próprio agente, está sob controle de um atacante. Ele tem o segredo do worker, recebe jobs, lê os inputs e devolve o que quiser.
- **Impacto:** alto. Resultados falsos, créditos indevidos e leitura dos inputs atribuídos àquele worker.
- **Probabilidade:** média. São PCs pessoais, fora do nosso controle.
- **Mitigação:**
  - O segredo fica protegido por DPAPI no Windows e em arquivo 0600 no Unix.
  - O token de sessão é HMAC com 15 min de validade, e a revogação é conferida a cada requisição.
  - O worker só vê e só age nas próprias atribuições.
  - Imagens: só as do lote atribuído.
  - **Novo:** o dono revoga o próprio computador (`POST /v1/provider/workers/:id/revoke`). O token morre na hora e os jobs são realocados.
  - **Novo:** o resultado de um worker comprometido não vale sozinho (verificação por réplica, item 3).
- **Testes:**
  - `security.test.ts` › *a provider revokes a stolen computer…*;
  - `jobs.test.ts` › *workers only see and act on their own assignments*;
  - `inference.test.ts` (imagens por lote).
- **Residual:** o atacante lê os inputs dos jobs que chegam àquela máquina até a revogação.

## 2. Job malicioso

- **Risco:** um input feito para explorar o agente, o runtime ou o decodificador. Exemplos: bomba de descompressão, JSON gigante, parâmetros fora de faixa.
- **Impacto:** alto, se levar a execução de código.
- **Probabilidade:** baixa. Não existe job com código: só tipos registrados, com módulos embutidos e fixados por hash.
- **Mitigação:**
  - Schemas estritos por tipo, com campos extras recusados.
  - Tamanhos limitados: input 256 KB, imagem 8 MB, lote 64 MB.
  - Tipo de imagem conferido pelos bytes (sniff), não pelo cabeçalho.
  - O sandbox tem limites de memória WASM e de processo, prazo por epoch e CPU.
  - **Novo:** filtro de syscalls e políticas de mitigação (item 5).
- **Testes:**
  - `jobs.test.ts` › *rejects invalid job*;
  - `security.test.ts` › *cannot run anything but registered workloads…*;
  - agente: `sandbox_process.rs` (limites de memória, imagem 4000×4000 sob 24 MB), `wasm_escape.rs`, `inference.rs`.
- **Residual:** um bug no wasmtime ou no decodificador ainda é possível. A contenção é o item 5.

## 3. Provedor malicioso

- **Risco:** o provedor devolve resultado falso com hash coerente para receber sem trabalhar. Também pode demorar de propósito para cobrar mais, recusar jobs como "inválidos" sem custo, ou combinar respostas com outras contas.
- **Impacto:** alto. O cliente recebe resultado errado, paga por ele, e a reputação é inflada.
- **Probabilidade:** alta numa plataforma aberta, sem controle.
- **Mitigação (nova):**
  - **Verificação por réplica,** padrão para contas públicas: o job só é concluído quando computadores de **donos diferentes** e de **redes diferentes** (/24 ou /48) concordam.
  - **Comparação por tipo:** no benchmark, trabalho e checksum iguais. Na inferência, rótulos e erros iguais e confiança com diferença de até 0,5%. O que decide a resposta nunca tem tolerância.
  - **Desempate:** uma terceira réplica desempata. Três respostas diferentes dão `RESULT_MISMATCH` com reembolso total.
  - **Isolamento das réplicas:** uma réplica nunca vê o resultado nem o checkpoint de outra.
  - **Quem perdeu:** não recebe, e conta como falha na reputação.
  - **`REQUIRE_TRUSTED_REPLICA=true`:** a réplica de verificação precisa rodar num computador da equipe (admin/operator), e o resultado dela decide. Isso derrota o conluio de contas que estão em redes diferentes.
  - **Novo: verificação aleatória (`TRUSTED_SPOT_CHECK_PERCENT`, padrão 10%).** Uma parte dos jobs verificados é sorteada na criação (RNG criptográfico, nunca mostrado a provedores) e a réplica de verificação dela vai para um computador da equipe, cujo resultado decide. Quem ele contradiz não recebe, perde reputação e vai para o log de auditoria (`verification.contradicted`, em `GET /v1/admin/audit`) para revisão. O job só espera por um computador da equipe enquanto houver um online, e no máximo `TRUSTED_SPOT_CHECK_WAIT_SECONDS` (padrão 600); sem nenhum, a verificação segue normal e nada atrasa.
  - **Enrolação:** cada réplica recebe no máximo 2× o tempo da réplica mais rápida que concordou, mais 30 s.
  - **"Job inválido":** em job verificado, essa alegação passa por uma segunda opinião. A falha só pesa na reputação se outro computador concluir o job.
- **Testes** (`security.test.ts`):
  - *only completed when two different owners agree*;
  - *a forged answer loses…*;
  - *three different answers…*;
  - *one owner cannot confirm itself*;
  - *two accounts behind one connection…*;
  - *REQUIRE_TRUSTED_REPLICA…*;
  - *spot checks…* (sorteio, conluio pego e registrado, sem espera sem computador da equipe, limite de espera);
  - `scheduler-engine.test.ts` › *spot checks wait for a trusted computer only while one is online…*;
  - *stalling…*;
  - *second opinion…*;
  - *fails everywhere…*;
  - *a replica never sees…*;
  - testes puros de `resultsAgree`, `verdict` e `networkPrefix`.
- **Residual:** sem `REQUIRE_TRUSTED_REPLICA`, duas contas em redes diferentes, controladas pela mesma pessoa, ainda podem confirmar uma mentira nos jobs que não foram sorteados, se ambas forem escolhidas para o mesmo job. Com computadores da equipe online, cada mentira tem `TRUSTED_SPOT_CHECK_PERCENT` de chance de ser pega e registrada, e quem é pego perde o pagamento e a reputação: mentir deixa de compensar. **Baixo** com computadores da equipe online; **Médio** sem nenhum. Com o modo confiável ligado, **Baixo**.

## 4. Cliente malicioso

- **Risco:**
  - cancelar perto do fim para não pagar;
  - mandar jobs que falham para derrubar a reputação de um provedor;
  - encher a fila ou o armazenamento;
  - gastar créditos que não tem.
- **Impacto:** médio.
- **Probabilidade:** alta.
- **Mitigação:**
  - O orçamento é reservado no ledger na criação (ADR 007: gasto duplo impossível).
  - **Novo:** cancelar um job em execução paga ao provedor o tempo trabalhado.
  - **Novo:** falha "do job" (não retentável) que acontece em todos os computadores não pesa para ninguém.
  - **Novo:** cotas por conta (item 11).
- **Testes:**
  - `security.test.ts` › *cancelling a running job still pays…*, *fails everywhere…*, *capped per public account…*;
  - `credits.test.ts` (gasto duplo, concorrência).
- **Residual:** baixo.

## 5. Fuga do sandbox

- **Risco:** código nativo escapa do WebAssembly, por bug no wasmtime ou no driver de GPU, e age como o usuário do agente.
- **Impacto:** alto. É a máquina de uma pessoa.
- **Probabilidade:** baixa. Não há código do cliente, e o módulo não tem imports do host.
- **Mitigação:**
  - Um processo `ghost-sandbox` por job: ambiente vazio, diretório vazio e privado, apagado ao final.
  - Linux: rlimits (AS, CPU, FSIZE=0 sem GPU, NOFILE=32, sem core) e `no_new_privs`.
  - Windows: Job Object (memória, CPU, um processo, restrições de UI, morte com o job).
  - **Novo — Linux:** filtro seccomp instalado pelo próprio sandbox **antes de ler o pedido**. Nega:
    - exec;
    - sockets IP, raw e netlink;
    - ptrace e process_vm;
    - mount, namespaces, BPF, perf, keyrings, módulos, io_uring e userfaultfd.
    ABI estrangeira ou x32 mata o processo.
  - **Novo — Windows:** políticas de mitigação no próprio processo:
    - sem processos filhos;
    - sem DLL remota ou de baixa integridade;
    - sem extension points;
    - checagem estrita de handles;
    - isolamento contra side channel quando o SO suporta.
  - **Novo:** se não conseguir se confinar, o sandbox não roda.
- **Testes:**
  - `security::confine` (processo filho confinado: cada chamada negada falha, o trabalho normal continua);
  - `sandbox_process.rs` › *sandbox_process_confines_itself…* (Seccomp 2 e NoNewPrivs no processo real no Linux; políticas lidas de fora no Windows);
  - toda a suíte do agente, inclusive a GPU via lavapipe, roda com o filtro ativo.
- **Residual:**
  - No Windows, sem AppContainer, um escape ainda teria a rede e o filesystem do usuário do agente. **Médio.** A recomendação de implantação está na última seção.
  - Timing de side channel (Spectre) entre jobs na mesma máquina é aceito como residual.

## 6. Roubo de credenciais

- **Risco:** vazamento de token de API, segredo de worker ou token de enrollment.
- **Impacto:** alto. Agir como a vítima e gastar os créditos dela.
- **Probabilidade:** média.
- **Mitigação:**
  - Tokens guardados só como hash.
  - Enrollment de uso único e com validade.
  - Rate limit nas rotas de credencial.
  - Logs com `authorization` e segredos redigidos.
  - Tokens nunca vão na URL.
  - **Novo:** tokens de contas públicas **expiram** (`MEMBER_TOKEN_TTL_DAYS`, padrão 30).
  - **Novo:** `/v1/me/tokens` para listar, criar (com a mesma validade máxima) e revogar os próprios tokens, com no máximo 20 ativos.
  - **Novo:** revogação do computador pelo dono.
  - **Novo:** tokens da equipe também **expiram** (`STAFF_TOKEN_TTL_DAYS`, padrão 90) e são trocados por `/v1/me/tokens`. Tokens antigos sem validade ganham 90 dias a partir da atualização (migração 012).
  - **Novo: verificação em duas etapas (TOTP, RFC 6238).** Obrigatória para a equipe (`REQUIRE_STAFF_MFA=true`, padrão): sem ela, a conta só acessa a própria página para ligá-la (o painel web guia com QR code). Opcional para contas públicas. Ligada, as ações que criam credenciais ou créditos pedem um código atual do app (`x-ghost-otp`): criar token, criar usuário, gerar código de conexão (admin e provedor), conceder créditos, desligar a própria verificação. Assim, um token roubado não consegue criar um substituto, outro admin, um computador "confiável" nem créditos; revogá-lo encerra o acesso. Cada código vale uma vez (último passo de 30 s guardado); 5 códigos errados bloqueiam por 15 minutos e ficam no log de auditoria (`mfa.failure`). O segredo fica cifrado no banco (AES-256-GCM, chave derivada de `WORKER_TOKEN_SECRET`). Celular perdido: `reset-mfa` no servidor.
- **Testes:**
  - `mfa.test.ts` (vetores das RFC 4226/6238, uso único, bloqueio, ações que pedem o código, `REQUIRE_STAFF_MFA` na API e no WebSocket, segredo cifrado, `reset-mfa`);
  - `security.test.ts` › *public tokens expire, can be rotated and revoked…*, *staff tokens expire too…*, *a provider revokes a stolen computer…*;
  - `auth.test.ts`;
  - agente: `credentials` (DPAPI, 0600).
- **Residual:** um token roubado de uma conta com verificação em duas etapas ainda vale, até expirar ou ser revogado, para o que não cria credenciais (ler dados, criar jobs). **Baixo.**

## 7. Man-in-the-middle

- **Risco:** interceptar o tráfego entre agente, cliente e servidor.
- **Impacto:** alto. Tokens, resultados e inputs.
- **Probabilidade:** baixa com TLS, alta sem ele.
- **Mitigação:**
  - O agente exige `https` (http só em loopback com opção explícita).
  - rustls com TLS 1.2+, raízes Mozilla embutidas (não as do SO) e pinning opcional de CA.
  - **Novo:** `REQUIRE_TLS=true` recusa HTTP simples e envia HSTS.
  - **Novo:** `X-Forwarded-Proto` só é aceito de proxies listados em `TRUST_PROXY`.
- **Testes:**
  - `security-http.test.ts` › *REQUIRE_TLS refuses plain HTTP…* (inclusive falsificação de `X-Forwarded-Proto` vindo de fora);
  - agente: `tls.rs` e testes de `configuration`.
- **Residual:** baixo, desde que a implantação siga a checklist.

## 8. Replay

- **Risco:** reenviar requisições capturadas ou repetidas para receber de novo, concluir de novo ou registrar de novo.
- **Impacto:** médio.
- **Probabilidade:** média.
- **Mitigação:**
  - Transições de estado com lock e checagem de estado: resultado, aceite e cancelamento repetidos dão 409.
  - Acerto de créditos com chave de idempotência única por job.
  - Concessões e saques com chave do cliente.
  - Enrollment de uso único.
  - Calibração com nonce.
  - Tokens de worker curtos.
  - Replay em rede é impedido pelo TLS.
- **Testes:**
  - `security.test.ts` › *replaying a result, an accept or an enrollment token changes nothing*;
  - `credits.test.ts` › idempotência concorrente.
- **Residual:** baixo.

## 9. Abuso de API

- **Risco:** o servidor confiava em `X-Forwarded-For` de qualquer cliente (`trustProxy: true`). Isso anulava os limites por IP do cadastro e das credenciais. Além disso, não havia limite global: só rotas de credencial e cadastro eram limitadas.
- **Impacto:** alto. Contas falsas em massa (Sybil), força bruta e raspagem de dados.
- **Probabilidade:** alta. Bastava um header.
- **Mitigação (nova):**
  - `TRUST_PROXY`: padrão é não confiar em proxy nenhum; aceita número de saltos ou lista de IPs/CIDRs.
  - Rate limit **global** de `RATE_LIMIT_PER_MINUTE` por credencial (hash do token) ou, sem credencial, por IP. Vale também para rotas inexistentes. Health checks ficam de fora.
  - Limites específicos mais duros continuam valendo: cadastro por IP e hora, credenciais, criação de tokens e de enrollments.
- **Testes:** `security-http.test.ts` › *every route is rate limited per credential…*, *forged X-Forwarded-For does not change the IP*.
- **Residual:** baixo.

## 10. DDoS

- **Risco:** saturar a API ou as conexões, por exemplo com slowloris ou muitas requisições.
- **Impacto:** alto. A plataforma inteira para.
- **Probabilidade:** média.
- **Mitigação:**
  - Limite de corpo (`MAX_BODY_BYTES`).
  - **Novo:** `requestTimeout`/`connectionTimeout` (`REQUEST_TIMEOUT_MS`) e `keepAliveTimeout` de 10 s.
  - **Novo:** rate limit global.
  - WebSocket restrito à equipe, com limite de mensagens.
  - Redis compartilhado entre instâncias.
- **Testes:** `security-http.test.ts` › timeouts, limite de corpo (413) e rate limit.
- **Residual:** um ataque volumétrico de rede está fora do alcance da aplicação. Exige um proxy ou CDN com proteção na frente (checklist). **Médio.**

## 11. Exaustão de recursos

- **Risco:**
  - Servidor: uma conta enche disco ou banco (datasets sem limite total por conta) ou a fila.
  - Worker: um job consome a máquina.
- **Impacto:** alto no servidor, médio no worker.
- **Probabilidade:** alta no servidor (antes).
- **Mitigação:**
  - Worker: limites de memória e CPU do sandbox e limites locais do dono, que o servidor não relaxa.
  - **Novo:** cotas por conta pública, conferidas sob lock da conta (inclusive em paralelo):
    - jobs ativos (`MEMBER_MAX_ACTIVE_JOBS`);
    - datasets (`MEMBER_MAX_DATASETS`);
    - bytes de imagens (`MEMBER_STORAGE_BYTES`).
    Cada job também tem orçamento em créditos.
- **Testes:**
  - `security.test.ts` › *active jobs, datasets and image storage are capped…*;
  - agente: `sandbox_process.rs` (limites de memória).
- **Residual:** baixo.

## 12. Vazamento de dados

- **Risco:** um participante vê dados de outro: jobs, carteiras, resultados, e-mails ou detalhes internos em erros.
- **Impacto:** alto.
- **Probabilidade:** média.
- **Mitigação:**
  - Papel `member`: só os próprios dados, e id alheio responde 404 (ADR 008).
  - Erros 5xx genéricos.
  - Mercado sem dono, e-mail nem uso.
  - **Novo:** réplicas não recebem resultado nem checkpoint de outras.
  - **Novo:** respostas da API com `no-store`, `nosniff`, `frame-ancestors 'none'` e sem referrer.
  - **Novo:** `x-request-id` do cliente só é aceito se for curto e simples (evita injeção em logs).
- **Testes:**
  - `security.test.ts` › *a replica never sees…*, *providers and customers see only their own side*;
  - `market.test.ts` › *members see only their own…*, *the public listing…*;
  - `security-http.test.ts` › headers, ids e erros.
- **Residual:** **o provedor vê o input dos jobs que executa.** É inerente a computar no computador de outra pessoa sem criptografia de uso. Médio, documentado para clientes: não enviar dados sensíveis.

## 13. Vazamento de memória de GPU

- **Risco:** um job lê, na VRAM, dados deixados por um job anterior de outro cliente.
- **Impacto:** alto.
- **Probabilidade:** baixa.
- **Mitigação:**
  - Cada job roda no próprio processo, com o próprio device wgpu, destruído no fim.
  - O wgpu zera buffers antes do primeiro uso, e o código nunca usa buffers mapeados sem inicializar.
  - O scheduler põe no máximo um job de GPU por worker.
- **Testes:**
  - `gpu::tests::fresh_gpu_buffers_never_expose_earlier_data` (no mesmo device e entre devices, lavapipe no CI);
  - `scheduler-core.test.ts` (GPU livre).
- **Residual:** um bug de driver fora do nosso controle. Baixo.

## 14. Acesso ao filesystem

- **Risco:** o workload lê ou grava arquivos do dono.
- **Impacto:** alto.
- **Probabilidade:** baixa.
- **Mitigação:**
  - Módulos WASM sem WASI: sem nenhum import de filesystem.
  - Diretório de trabalho vazio e privado.
  - `RLIMIT_FSIZE=0` no Linux sem GPU.
  - **Novo:** seccomp nega mount, chroot e `open_by_handle_at`.
  - **Novo:** Windows sem DLLs remotas ou de baixa integridade.
- **Testes:**
  - `wasm_escape.rs` › *wasi_filesystem_imports_are_refused*;
  - `sandbox_process.rs` › *unix_confinement_blocks_file_creation*, *sandbox_environment_is_empty*.
- **Residual:** no Windows, só depois de uma fuga (item 5).

## 15. Abuso de rede

- **Risco:**
  - O workload usa a rede do provedor para atacar terceiros ou vazar dados.
  - O servidor é usado para buscar URLs (SSRF).
- **Impacto:** alto.
- **Probabilidade:** baixa.
- **Mitigação:**
  - Módulos sem imports de socket.
  - O agente só fala com o servidor configurado, em HTTPS.
  - O servidor não busca URLs: datasets chegam como bytes.
  - **Novo:** seccomp nega sockets IP, raw e netlink no sandbox (só AF_UNIX, para drivers).
- **Testes:**
  - `wasm_escape.rs` › imports de socket recusados;
  - `security::confine` › *no_internet_or_raw_sockets*.
- **Residual:** no Windows depende do firewall (checklist).

## 16. Supply chain

- **Risco:** dependência vulnerável ou maliciosa, ação de CI comprometida, binário adulterado.
- **Impacto:** alto.
- **Probabilidade:** média.
- **Mitigação:**
  - Lockfiles com `npm ci`.
  - Toolchain Rust fixada: 1.95.0 no agente, 1.94.1 nos workloads (bytes dos módulos WASM).
  - **Novo:** wasmtime 48.0.3, com as correções de RUSTSEC-2026-0315 (amplificação de fuel por `call_ref`/`catch`) e RUSTSEC-2026-0316 (alocação além do limite de fuel).
  - Módulos WASM fixados por SHA-256, com build reproduzível verificado no CI.
  - Sem OpenSSL (rustls).
  - Nenhum auto-update implementado, portanto nenhum canal de update para atacar.
  - **Novo:** workflow `security.yml` roda `cargo audit` em todos os `Cargo.lock` e `npm audit` (high) nos três pacotes, a cada mudança e toda semana. Os workflows existentes também rodam `npm audit`.
  - **Novo:** `permissions: contents: read` em todos os workflows (token de CI só leitura).
  - **Novo:** Dependabot para npm, cargo e GitHub Actions.
  - **Novo:** GitHub Actions fixadas por SHA do commit (com a versão em comentário); uma tag movida por terceiros não muda o que roda no CI. O Dependabot atualiza SHA e comentário juntos.
  - **Novo:** assinatura de código pronta no build ([installer/windows/sign.ps1](../../installer/windows/sign.ps1)): programas, MSI e `setup.exe` (engine e pacote), SHA-256 com carimbo de tempo, cada assinatura verificada. Liga sozinha com o certificado nos secrets `WINDOWS_SIGN_PFX_BASE64`/`_PASSWORD`; sem ele, o CI prova o processo com um certificado descartável em cópias.
  - **Novo:** `rustls-pemfile` (RUSTSEC-2025-0134, sem manutenção) removido; o parsing de PEM agora usa o próprio rustls.
- **Estado na auditoria:**
  - `npm audit`: 0 vulnerabilidades em control-plane, dashboard e desktop.
  - `cargo audit`: 0 vulnerabilidades. Avisos restantes: crates sem manutenção no stack Linux do Tauri (glib, unic-*, proc-macro-error), fora do build Windows do app.
- **Residual:**
  - Binários ainda não são assinados (Authenticode): o processo está pronto, falta o certificado.
  - **Médio.**

---

## Pronto para usuários externos?

Todos os riscos **críticos** encontrados têm mitigação e teste automatizado:

- provedor malicioso: verificação por réplica;
- abuso de API: proxy confiável e rate limit global.

Nenhum risco residual está acima de **Médio**.

Mesmo assim, a abertura depende destas condições de **implantação**. Elas não são código, e sem elas os controles acima perdem efeito:

1. **Terminação TLS** num proxy, com `TRUST_PROXY` = o IP ou CIDR do proxy e `REQUIRE_TLS=true`.
2. **Proteção volumétrica** (CDN ou proxy com limite por IP) na frente da API.
3. **Computadores da equipe online** (de contas admin/operator), para a verificação aleatória (`TRUSTED_SPOT_CHECK_PERCENT`, ligada por padrão) ter quem verifique. Sem nenhum, o conluio entre contas em redes diferentes fica em risco Médio. `REQUIRE_TRUSTED_REPLICA=true` verifica todos os jobs, se houver capacidade para isso.
4. **Windows:** regra de firewall que bloqueia a saída de rede do `ghost-sandbox.exe`, para fechar o residual dos itens 5 e 15. **Feito:** o instalador cria a regra e o CI confere ([installer/windows](../../installer/windows/README.md)).
5. **Binários assinados** (Authenticode) antes da distribuição pública: basta colocar o certificado nos secrets do repositório ([installer/windows](../../installer/windows/README.md#assinatura-de-código-authenticode)).
6. **Aviso aos clientes:** provedores veem os inputs; dados sensíveis não devem ser enviados.

O item 5 (assinatura) depende só do certificado: o build e o CI já assinam e verificam quando ele existe.

## Riscos residuais (Médio)

| Ameaça | Residual | Próximo passo |
|---|---|---|
| 3 | Conluio de contas em redes diferentes, sem computadores da equipe online | Manter computadores da equipe online (verificação aleatória) ou `REQUIRE_TRUSTED_REPLICA=true` |
| 5 / 15 | Windows sem AppContainer: um escape teria rede e arquivos do usuário | Criar o sandbox com AppContainer ou token restrito; firewall no instalador |
| 10 | DDoS volumétrico | CDN/WAF |
| 12 | Provedor vê inputs | Documentado; computação confidencial está fora do escopo |
| 16 | Binários sem assinatura (processo pronto, falta o certificado) | Certificado de assinatura de código nos secrets |
