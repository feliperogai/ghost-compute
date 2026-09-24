// Everything the owner reads about state lives here: pure and unit-tested.
import type { ConnectionStatus, Reason, Status } from './types';

export type Tone = 'off' | 'paused' | 'waiting' | 'ready' | 'running' | 'problem';

export interface Headline {
  tone: Tone;
  title: string;
  detail: string;
}

const fmtDur = (secs: number): string => {
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
};
export const duration = fmtDur;

export const pct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;

export function size(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export const celsius = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)} °C`;

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nunca';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 5) return 'agora';
  if (s < 60) return `há ${Math.round(s)} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

export function reasonText(r: Reason): string {
  switch (r.reason) {
    case 'disabled':
      return 'Compartilhamento desativado nas configurações';
    case 'paused_by_owner':
      return 'Pausado por você';
    case 'stopped_by_owner':
      return 'Desligado por você';
    case 'outside_schedule':
      return 'Fora do horário permitido';
    case 'on_battery':
      return 'Computador na bateria';
    case 'too_hot':
      return `Temperatura alta: ${celsius(r.celsius)} (limite ${celsius(r.limit)})`;
    case 'owner_cpu_busy':
      return `Você está usando a CPU: ${pct(r.percent)} (limite ${pct(r.limit)})`;
    case 'ram_pressure':
      return `Memória quase cheia: ${pct(r.percent)} (limite ${pct(r.limit)})`;
    case 'owner_active':
      return `Você está usando o computador (sem uso há ${fmtDur(r.idle_secs)}; precisa de ${fmtDur(r.required)})`;
    case 'presence_unknown':
      return 'Não dá para saber se você está usando o computador: deixe o app ghost aberto (ícone perto do relógio)';
    case 'session_unlocked':
      return 'Sessão desbloqueada: configurado para usar só com o computador bloqueado';
    case 'game_running':
      return 'Jogo ou aplicativo em tela cheia aberto';
    case 'priority_app_running':
      return `Aplicativo prioritário aberto: ${r.app}`;
    case 'cooling_down':
      return `Tudo certo. Liberando em ${fmtDur(r.remaining_secs)}`;
    case 'execution_unavailable':
      return 'Esta versão do agente ainda não executa trabalhos';
    case 'no_data':
      return 'Coletando as primeiras medições';
  }
}

export function connectionText(c: ConnectionStatus): { label: string; ok: boolean } {
  switch (c) {
    case 'connected':
      return { label: 'Conectado', ok: true };
    case 'connecting':
      return { label: 'Conectando…', ok: false };
    case 'reconnecting':
      return { label: 'Sem conexão. Tentando novamente', ok: false };
    case 'revoked':
      return { label: 'Acesso revogado', ok: false };
    case 'invalid_credentials':
      return { label: 'Credenciais recusadas', ok: false };
  }
}

/** The one sentence at the top of the window. Order matters: most important first. */
export function headline(s: Status): Headline {
  if (s.connection.status === 'revoked')
    return {
      tone: 'problem',
      title: 'Computador removido da rede',
      detail: 'Um administrador revogou o acesso. Nada será executado aqui.',
    };
  if (s.connection.status === 'invalid_credentials')
    return {
      tone: 'problem',
      title: 'Credenciais recusadas',
      detail: 'Cadastre este computador novamente. Nada será executado até lá.',
    };
  const w = s.workloads[0];
  if (w)
    return {
      tone: 'running',
      title: s.workloads.length > 1 ? `Executando ${s.workloads.length} trabalhos` : 'Executando um trabalho',
      detail: `Seu computador está processando “${w.jobName}” para a rede. Pause ou pare quando quiser: o trabalho é interrompido na hora.`,
    };
  if (s.state === 'running')
    return { tone: 'running', title: 'Executando um trabalho', detail: 'Finalizando.' };
  if (s.control === 'stopped')
    return {
      tone: 'off',
      title: 'Compartilhamento desligado',
      detail: 'Nada é executado neste computador. Clique em Iniciar para contribuir.',
    };
  if (s.control === 'paused')
    return { tone: 'paused', title: 'Pausado por você', detail: 'Nenhum trabalho será aceito até você retomar.' };
  if (!s.limits.enabled)
    return { tone: 'off', title: 'Compartilhamento desativado', detail: 'Ative nas configurações para contribuir.' };
  if (s.state === 'available')
    return {
      tone: 'ready',
      title: 'Pronto para contribuir',
      detail: 'Todas as condições foram atendidas. Esperando um trabalho do servidor.',
    };
  if (s.state === 'waiting') {
    const first = s.reasons[0];
    return { tone: 'waiting', title: 'Aguardando', detail: first ? reasonText(first) : 'Verificando condições.' };
  }
  return { tone: 'waiting', title: 'Verificando o computador…', detail: 'Coletando as primeiras medições.' };
}

export function taskStatusText(status: string): string {
  return (
    {
      assigned: 'Atribuído',
      running: 'Executando',
      completed: 'Concluído',
      failed: 'Falhou',
      timeout: 'Tempo esgotado',
      lost: 'Interrompido',
      expired: 'Não aceito a tempo',
      cancelled: 'Cancelado',
    } as Record<string, string>
  )[status] ?? status;
}

export const DAYS: { key: string; short: string }[] = [
  { key: 'mon', short: 'Seg' },
  { key: 'tue', short: 'Ter' },
  { key: 'wed', short: 'Qua' },
  { key: 'thu', short: 'Qui' },
  { key: 'fri', short: 'Sex' },
  { key: 'sat', short: 'Sáb' },
  { key: 'sun', short: 'Dom' },
];
