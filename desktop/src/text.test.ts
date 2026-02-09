import fixture from './fixtures/status.agent.json';
import type { Status } from './types';
import { headline, reasonText, relativeTime, size, duration, connectionText } from './text';

const base = fixture as unknown as Status;
const with_ = (p: Partial<Status>): Status => ({ ...base, ...p });

describe('headline', () => {
  it('real agent fixture: started but waiting because execution is unavailable', () => {
    expect(headline(base)).toEqual({
      tone: 'waiting',
      title: 'Aguardando',
      detail: 'Esta versão do agente ainda não executa trabalhos',
    });
  });

  it('priorities: revoked > running > stopped > paused > ready', () => {
    const running = with_({
      workloads: [
        {
          leaseId: 'l',
          jobId: 'j',
          jobName: 'Render',
          module: { name: 'blender', version: '4.2.0' },
          progress: 0.42,
          stage: null,
          startedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    expect(headline(running)).toMatchObject({ tone: 'running', title: 'Executando um trabalho' });
    expect(headline(running).detail).toContain('“Render”');
    expect(headline({ ...running, connection: { ...base.connection, status: 'revoked' } }).tone).toBe('problem');
    expect(headline(with_({ control: 'stopped', state: 'stopped' })).tone).toBe('off');
    expect(headline(with_({ control: 'paused', state: 'paused' })).tone).toBe('paused');
    expect(headline(with_({ state: 'available', reasons: [] })).tone).toBe('ready');
    expect(headline(with_({ limits: { ...base.limits, enabled: false } })).tone).toBe('off');
    expect(headline(with_({ state: null, reasons: [] })).title).toMatch(/Verificando/);
  });
});

describe('reasons', () => {
  it('explains every limit in plain language', () => {
    expect(reasonText({ reason: 'owner_cpu_busy', percent: 45.4, limit: 30 })).toBe(
      'Você está usando a CPU: 45% (limite 30%)',
    );
    expect(reasonText({ reason: 'too_hot', celsius: 88.6, limit: 85 })).toBe('Temperatura alta: 89 °C (limite 85 °C)');
    expect(reasonText({ reason: 'owner_active', idle_secs: 12, required: 300 })).toMatch(/12 s.*5 min/);
    expect(reasonText({ reason: 'priority_app_running', app: 'obs64' })).toMatch(/obs64/);
    expect(reasonText({ reason: 'cooling_down', remaining_secs: 45 })).toMatch(/45 s/);
  });
});

describe('formatters', () => {
  it('formats sizes, durations and times', () => {
    expect(size(512)).toBe('512 MB');
    expect(size(16095)).toBe('16 GB');
    expect(size(3072)).toBe('3.0 GB');
    expect(size(null)).toBe('—');
    expect(duration(3900)).toBe('1 h 5 min');
    const now = Date.parse('2026-01-01T00:10:00Z');
    expect(relativeTime('2026-01-01T00:09:58Z', now)).toBe('agora');
    expect(relativeTime('2026-01-01T00:05:00Z', now)).toBe('há 5 min');
    expect(relativeTime(null, now)).toBe('nunca');
    expect(connectionText('reconnecting').ok).toBe(false);
  });
});
