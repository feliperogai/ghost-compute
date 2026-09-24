# Instalador Windows do ghost Worker

Gera dois arquivos:

| Arquivo | Para quem |
|---|---|
| `ghost-worker-setup-<versão>.exe` | Donos de computador. Instala o WebView2 se faltar e depois o Worker, com todas as telas explicativas. |
| `ghost-worker-<versão>.msi` | TI e implantação em massa (GPO, Intune, `msiexec`). Mesmas telas; também funciona em modo silencioso. |

## O que o instalador faz

Tudo isto é mostrado ao dono antes de instalar, e fica instalado em
[COMO-FUNCIONA.txt](COMO-FUNCIONA.txt) (Menu Iniciar › ghost › *Como o ghost funciona*).

| Passo | Como |
|---|---|
| 1. Instala o Worker | `C:\Program Files\ghost\`: `ghost-agent.exe` (serviço), `ghost-sandbox.exe` (executa os trabalhos, isolado), `ghost.exe` (app/painel) e `COMO-FUNCIONA.txt`. |
| 2. Dependências | Pelo `setup.exe`: WebView2 Runtime (janela do app), só se faltar. O bootstrapper é da Microsoft e tem a assinatura conferida no build. Sem Visual C++ (runtime estático) e sem drivers extras (a GPU usa Direct3D 12 do Windows). |
| 3. Registra o serviço | `GhostWorker` ("ghost Worker"): conta virtual `NT SERVICE\GhostWorker`, sem privilégio de administrador; inicialização automática atrasada; reinicia após falha. |
| 4. Inicia o serviço | Ao fim da instalação. O compartilhamento continua **desligado** até o dono clicar em *Iniciar* no app. |
| 5. Firewall, só o necessário | Nenhuma porta é aberta (o agente só faz conexões de saída HTTPS). Uma regra **bloqueia** a rede do `ghost-sandbox.exe`. Pode ser desmarcada na tela de opções. |
| 6. Configuração segura | `C:\ProgramData\ghost\` com ACL protegida: só SYSTEM, Administradores e o serviço. O `agent.toml` é escrito pelo próprio agente, que aceita só `https`. Credenciais protegidas por DPAPI. |
| 7. Login | Na instalação: código de conexão `ghe_…` (opcional). Depois: pelo app, com o código ou o token da conta `ghu_…`. O token da conta é usado uma vez e nunca é guardado. O código deixado pelo instalador é lido e apagado pelo serviço ao iniciar. |
| 8. Atalhos | Menu Iniciar: *ghost* (painel deste computador), *Como o ghost funciona* e *Desinstalar ghost*. Na Área de Trabalho: *ghost* (opcional). O app abre com o Windows, perto do relógio (opcional, recomendado). |
| 9. Remoção limpa | Avisa o servidor que o computador saiu. Remove serviço, programas, `C:\ProgramData\ghost` inteira, regra de firewall, atalhos, inicialização automática e `HKLM\SOFTWARE\ghost`. Atualizações preservam configuração e credenciais. |

Telas, na ordem:
1. Boas-vindas.
2. **Como o ghost funciona**: recursos usados, quando pode rodar, como pausar e como remover. Só avança marcando "Li e entendi".
3. **Conectar e opções**.
4. Pronto para instalar.
5. Concluído: avisa que o compartilhamento está DESLIGADO e oferece abrir o app.

Na remoção aparece a tela **O que a remoção faz**.

## Instalação silenciosa

```powershell
msiexec /i ghost-worker-0.1.X.msi /qn SERVER_URL=https://ghost.suaempresa.com ENROLLMENT_TOKEN=ghe_... `
        DESKTOP_SHORTCUT=0 AUTOSTART_APP=1 FIREWALL_RULE=1
msiexec /x ghost-worker-0.1.X.msi /qn
```

| Propriedade | Padrão | Efeito |
|---|---|---|
| `SERVER_URL` | valor do build | Servidor. Precisa ser `https://`. |
| `ENROLLMENT_TOKEN` | vazio | Código de conexão de uso único. Marcado como oculto: não vai para o log do MSI (há teste para isso). |
| `AUTOSTART_APP` | 1 | App na bandeja ao entrar no Windows. Sem ele o serviço não sabe se há alguém usando o computador, e **não compartilha**. |
| `DESKTOP_SHORTCUT` | 1 | Atalho do painel na Área de Trabalho. |
| `FIREWALL_RULE` | 1 | Regra que bloqueia a rede do sandbox. |

## Build

No Windows, com .NET SDK 8, Node 22 e Rust:

```powershell
cd agent;   cargo build --release --bins
cd desktop; npm ci; npx tauri build --no-bundle
./installer/windows/build.ps1 -Version 0.1.0 -BinDir agent/target/release `
  -DesktopExe desktop/src-tauri/target/release/ghost-desktop.exe -ServerUrl https://ghost.suaempresa.com
./installer/windows/test-install.ps1 -Msi installer/windows/out/ghost-worker-0.1.0.msi   # máquina descartável
```

WiX Toolset 5.0.2, fixado. O CI (`.github/workflows/installer.yml`) faz tudo isso num Windows limpo.
O `test-install.ps1` confere cada item das tabelas acima depois de instalar, e de novo depois de remover.

## Pendente para distribuição pública

- **Assinatura de código (Authenticode)** do MSI, do `setup.exe` e dos `.exe`. Sem ela, o SmartScreen avisa. Precisa de um certificado da organização; o passo entra no CI quando o certificado existir.
- **Outros firewalls:** com firewall de terceiros no lugar do Firewall do Windows, a regra do sandbox precisa ser criada nele. Uma falha do `netsh` não interrompe a instalação.
