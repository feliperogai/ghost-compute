import { useMemo } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { isTauri, tauriApi, type AgentApi } from './api';
import { MockAgent, type Scenario } from './mock';
import { useAgent } from './useAgent';
import { Hero } from './components/Hero';
import { Resources, SidePanels } from './components/Overview';
import { Jobs } from './components/Jobs';
import { Settings } from './components/Settings';
import { Connect } from './components/Connect';
import { connectionText } from './text';

function defaultApi(): AgentApi {
  if (isTauri()) return tauriApi();
  const scenario = (new URLSearchParams(location.search).get('scenario') ?? 'waiting') as Scenario;
  return new MockAgent(scenario);
}

export function App({ api: injected }: { api?: AgentApi }) {
  const api = useMemo(() => injected ?? defaultApi(), [injected]);
  const agent = useAgent(api);
  const { status, error } = agent;

  // Not connected yet: the agent runs but has no account; nothing is shared.
  if (error?.code === 'NOT_ENROLLED') return <Connect api={api} reason={error.message} />;

  if (!status) {
    return error ? <Unreachable /> : <div className="app" aria-busy="true" />;
  }

  const conn = connectionText(status.connection.status);
  const connClass = conn.ok ? 'ok' : status.connection.status === 'revoked' ? 'alarm' : 'bad';

  return (
    <div className="app">
      <header className="header">
        <span className="wordmark">ghost</span>
        <span className="machine">{status.agent.name}</span>
        <span className="conn" data-testid="conn">
          <span className={`dot ${connClass}`} aria-hidden />
          {conn.label}
        </span>
      </header>

      {error && (
        <div className="banner" role="alert">
          Sem contato com o agente. Mostrando o último estado conhecido.
        </div>
      )}

      <Hero status={status} pending={agent.pending} onControl={(a) => void agent.control(a)} />

      <Tabs.Root defaultValue="now">
        <Tabs.List className="tabs-list" aria-label="Seções">
          <Tabs.Trigger className="tab" value="now">Agora</Tabs.Trigger>
          <Tabs.Trigger className="tab" value="jobs">Trabalhos</Tabs.Trigger>
          <Tabs.Trigger className="tab" value="settings">Configurações</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="now">
          <div className="overview">
            <Resources status={status} />
            <SidePanels status={status} />
          </div>
        </Tabs.Content>
        <Tabs.Content value="jobs">
          <Jobs status={status} />
        </Tabs.Content>
        <Tabs.Content value="settings">
          <Settings status={status} onSave={agent.saveSettings} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function Unreachable() {
  return (
    <div className="app">
      <div className="unreachable" role="alert">
        <h1>O agente ghost não está em execução</h1>
        <p>
          Este aplicativo só mostra e controla o agente. Sem ele, nada é compartilhado e nenhum trabalho roda
          neste computador.
        </p>
        <p>
          Para iniciar: abra <b>Serviços</b> do Windows e inicie <code>ghost Worker</code> (GhostWorker), ou
          reinstale o ghost.
        </p>
        <p className="retry">
          <span className="dot bad" aria-hidden /> Tentando reconectar a cada segundo…
        </p>
      </div>
    </div>
  );
}
