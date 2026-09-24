import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { AgentError, type AgentApi } from './api';
import { MockAgent } from './mock';
import type { Limits } from './types';

async function renderWith(api: AgentApi) {
  const user = userEvent.setup();
  render(<App api={api} />);
  await screen.findByRole('heading', { level: 1 });
  return user;
}

describe('controls', () => {
  it('fresh install is stopped; Start asks the agent and updates the headline', async () => {
    const mock = new MockAgent('stopped');
    const user = await renderWith(mock);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Compartilhamento desligado');
    expect(screen.getByRole('button', { name: 'Parar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Iniciar compartilhamento' }));
    expect(mock.calls).toContain('control:start');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Aguardando');
    expect(screen.getByRole('button', { name: 'Iniciar compartilhamento' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Parar' })).toBeEnabled();
  });

  it('shows the running workload clearly and stops it', async () => {
    const mock = new MockAgent('running');
    const user = await renderWith(mock);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Executando um trabalho');
    const w = screen.getByTestId('active-workload');
    expect(w).toHaveTextContent('Simulação Monte Carlo — lote 14');
    expect(within(w).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByTestId('jobs-active')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: 'Parar' }));
    expect(mock.calls).toEqual(['control:stop']);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Compartilhamento desligado');
    expect(screen.queryByTestId('active-workload')).toBeNull();
  });

  it('pause from waiting', async () => {
    const mock = new MockAgent('waiting');
    const user = await renderWith(mock);
    expect(screen.getByText(/Você está usando o computador/)).toBeInTheDocument();
    expect(screen.getByText('Jogo ou aplicativo em tela cheia aberto')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Pausado por você');
  });
});

describe('overview', () => {
  it('shows resources, limits, credits and connection', async () => {
    await renderWith(new MockAgent('running'));
    expect(screen.getByTestId('meter-CPU')).toHaveTextContent('Disponibilizado: até 40%');
    expect(screen.getByTestId('meter-CPU')).toHaveTextContent('ghost 37%');
    expect(screen.getByTestId('meter-RAM')).toHaveTextContent('Disponibilizado: até 4.0 GB');
    expect(screen.getByTestId('meter-VRAM')).toHaveTextContent('12 GB');
    expect(screen.getByTestId('meter-Temperatura')).toHaveTextContent('Pausa acima de 80 °C');
    expect(screen.getByTestId('credits')).toHaveTextContent('696');
    expect(screen.getByTestId('jobs-done')).toHaveTextContent('128');
    expect(screen.getByTestId('conn')).toHaveTextContent('Conectado');
  });

  it('real agent fixture renders without GPU or temperature data', async () => {
    const mock = new MockAgent('noagent');
    // Use the raw fixture path: status() of a non-failing clone.
    const api: AgentApi = { ...mock, status: async () => (await import('./fixtures/status.agent.json')).default as never, control: mock.control.bind(mock), saveSettings: mock.saveSettings.bind(mock), enroll: mock.enroll.bind(mock) };
    await renderWith(api);
    expect(screen.getByTestId('meter-GPU')).toHaveTextContent('Nenhuma GPU detectada');
    expect(screen.getByTestId('meter-Temperatura')).toHaveTextContent('Sem sensor');
    expect(screen.getByTestId('meter-VRAM')).toHaveTextContent('Não informado');
  });

  it('warns when the server connection is down', async () => {
    await renderWith(new MockAgent('reconnecting'));
    expect(screen.getByTestId('conn')).toHaveTextContent('Sem conexão');
    expect(screen.getByText('network error: connection refused')).toBeInTheDocument();
  });
});

describe('agent unreachable', () => {
  it('explains that nothing runs without the agent', async () => {
    render(<App api={new MockAgent('noagent')} />);
    expect(await screen.findByText('O agente ghost não está em execução')).toBeInTheDocument();
    expect(screen.getByText(/nada é compartilhado/)).toBeInTheDocument();
  });

  it('keeps last known state with a banner when the agent disappears', async () => {
    const mock = new MockAgent('waiting');
    let down = false;
    const api: AgentApi = {
      status: () => (down ? Promise.reject(new AgentError('AGENT_UNREACHABLE', 'gone')) : mock.status()),
      control: (a) => mock.control(a),
      enroll: (t) => mock.enroll(t),
      saveSettings: (l) => mock.saveSettings(l),
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App api={api} />);
    await screen.findByRole('heading', { level: 1 });
    down = true;
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(screen.getByRole('alert')).toHaveTextContent('Sem contato com o agente');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aguardando');
    vi.useRealTimers();
  });
});

describe('settings', () => {
  async function openSettings(api: AgentApi) {
    const user = await renderWith(api);
    await user.click(screen.getByRole('tab', { name: 'Configurações' }));
    return user;
  }

  it('edits, saves through the agent and can discard', async () => {
    const mock = new MockAgent('ready');
    const saved: Limits[] = [];
    const api: AgentApi = {
      status: () => mock.status(),
      control: (a) => mock.control(a),
      enroll: (t) => mock.enroll(t),
      saveSettings: async (l) => {
        saved.push(l);
        return mock.saveSettings(l);
      },
    };
    const user = await openSettings(api);
    expect(screen.queryByText('Alterações não salvas.')).toBeNull();

    // jsdom does not move range inputs with the keyboard; set the value directly.
    fireEvent.change(screen.getByLabelText('CPU máximo permitido'), { target: { value: '50' } });
    expect(screen.getByText('50%', { selector: 'output' })).toBeInTheDocument();
    expect(screen.getByText('Alterações não salvas.')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Executar somente com o PC bloqueado'));
    await user.click(screen.getByLabelText('Durante jogos'));
    await user.type(screen.getByLabelText('Com aplicativos prioritários abertos'), 'obs64.exe{Enter}');
    expect(screen.getByRole('button', { name: 'Remover obs64.exe' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Configurações salvas e aplicadas.')).toBeInTheDocument();
    expect(saved[0]).toMatchObject({
      max_cpu_percent: 50,
      only_when_locked: true,
      pause_during_games: false,
      priority_apps: ['obs64.exe'],
    });

    await user.click(screen.getByLabelText('Pausar na bateria'));
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('schedule editor and idle minutes', async () => {
    const mock = new MockAgent('ready');
    const user = await openSettings(mock);
    await user.click(screen.getByRole('radio', { name: 'Só em horários definidos' }));
    expect(screen.getAllByTestId('schedule-window')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Sex' }));
    await user.click(screen.getByLabelText('Executar somente com o PC ocioso'));
    const minutes = screen.getByLabelText('Minutos sem uso');
    await user.clear(minutes);
    await user.type(minutes, '10');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByText('Configurações salvas e aplicadas.');
    const l = (await mock.status()).limits;
    expect(l.schedule).toEqual([{ days: ['mon', 'tue', 'wed', 'thu'], from: '22:00', to: '07:00' }]);
    expect(l.require_idle_secs).toBe(600);
  });

  it('shows the agent validation error and keeps the draft', async () => {
    const mock = new MockAgent('ready');
    const api: AgentApi = {
      status: () => mock.status(),
      control: (a) => mock.control(a),
      enroll: (t) => mock.enroll(t),
      saveSettings: () => Promise.reject(new AgentError('INVALID_SETTINGS', 'invalid config: limits.schedule: bad time')),
    };
    const user = await openSettings(api);
    await user.click(screen.getByLabelText('Durante jogos'));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(/Não foi possível salvar: invalid config/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled();
  });
});

describe('connecting this computer', () => {
  it('asks for a token while not connected; connecting does not start sharing', async () => {
    const mock = new MockAgent('not-enrolled');
    const user = userEvent.setup();
    render(<App api={mock} />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Conectar este computador');
    expect(screen.getByTestId('connect-reason')).toHaveTextContent('https://ghost.example.com');
    expect(screen.getByText(/nada é compartilhado/)).toBeInTheDocument();
    const input = screen.getByLabelText('Código de conexão ou token da conta');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeDisabled();

    await user.type(input, 'senha123');
    await user.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('o token deve começar com ghe_');

    await user.clear(input);
    await user.type(input, 'ghe_used');
    await user.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('já usado');

    await user.clear(input);
    await user.type(input, 'ghe_good');
    await user.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(mock.calls.filter((c) => c === 'enroll')).toHaveLength(3);
    // Once connected the normal panel appears — with sharing still off.
    expect(await screen.findByRole('heading', { level: 1, name: /Compartilhamento desligado/ }, { timeout: 3000 })).toBeInTheDocument();
    expect(mock.calls).not.toContain('control:start');
  });
});
