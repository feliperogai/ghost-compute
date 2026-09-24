import type { ReactNode } from 'react';
import type { Range } from '../api';

export function StatTile({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  );
}

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

/** Status always as dot + label, never color alone. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const STATE: Record<string, [Tone, string]> = {
  available: ['good', 'disponível'],
  running: ['good', 'executando'],
  waiting: ['warning', 'aguardando'],
  paused: ['warning', 'pausado'],
  stopped: ['neutral', 'parado'],
  offline: ['critical', 'offline'],
};
export function StateBadge({ state }: { state: string }) {
  const [tone, label] = STATE[state] ?? ['neutral', state];
  return <Badge tone={tone}>{label}</Badge>;
}

export function tempTone(t: number | null, max: number | null | undefined): Tone {
  if (t === null) return 'neutral';
  const limit = max ?? 85;
  return t >= limit - 3 ? 'critical' : t >= limit - 10 ? 'serious' : t >= limit - 20 ? 'warning' : 'good';
}

export function Meter({ value, label }: { value: number | null; label: string }) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: [Range, string][] = [
    ['1h', '1 hora'],
    ['6h', '6 horas'],
    ['24h', '24 horas'],
    ['7d', '7 dias'],
  ];
  return (
    <div className="segmented" role="group" aria-label="Período">
      {opts.map(([r, l]) => (
        <button key={r} aria-pressed={value === r} onClick={() => onChange(r)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function ErrorNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  const e = error as Error & { requestId?: string; status?: number };
  return (
    <div className="notice err" role="alert">
      Falha ao carregar: {e.message}
      {e.status ? ` (HTTP ${e.status})` : ''}
      {e.requestId ? <span className="mono"> · request {e.requestId}</span> : null}
    </div>
  );
}
