import type { ControlAction, Status } from '../types';
import { duration, headline, pct, reasonText } from '../text';

interface Props {
  status: Status;
  pending: ControlAction | null;
  onControl(a: ControlAction): void;
}

export function Hero({ status, pending, onControl }: Props) {
  const h = headline(status);
  const c = status.control;
  // Show every reason when waiting; the first one is already the detail line.
  const extra = h.tone === 'waiting' ? status.reasons.slice(1) : [];
  const blocked = status.connection.status === 'revoked' || status.connection.status === 'invalid_credentials';

  return (
    <section className="hero" data-tone={h.tone} aria-live="polite">
      <div>
        <div className="state-line">
          <span className="state-mark" aria-hidden />
          <h1 className="state-title">{h.title}</h1>
        </div>
        <p className="state-detail">{h.detail}</p>
        {extra.length > 0 && (
          <ul className="reasons">
            {extra.map((r, i) => (
              <li key={i}>{reasonText(r)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="controls" role="group" aria-label="Controle do compartilhamento">
        <button
          className="btn primary"
          disabled={c === 'started' || blocked || pending !== null}
          aria-pressed={c === 'started'}
          onClick={() => onControl('start')}
        >
          {pending === 'start' ? 'Iniciando…' : 'Iniciar compartilhamento'}
        </button>
        <button
          className="btn"
          disabled={c !== 'started' || pending !== null}
          aria-pressed={c === 'paused'}
          onClick={() => onControl('pause')}
        >
          {pending === 'pause' ? 'Pausando…' : 'Pausar'}
        </button>
        <button
          className="btn danger"
          disabled={c === 'stopped' || pending !== null}
          aria-pressed={c === 'stopped'}
          onClick={() => onControl('stop')}
        >
          {pending === 'stop' ? 'Parando…' : 'Parar'}
        </button>
      </div>

      {status.workloads.map((w) => {
        const elapsed = (Date.parse(status.generatedAt) - Date.parse(w.startedAt)) / 1000;
        return (
          <div className="workload" key={w.leaseId} data-testid="active-workload">
            <div>
              <div className="workload-title">{w.jobName}</div>
              <div className="workload-meta">
                Módulo {w.module.name} {w.module.version}
                {w.stage ? ` · ${w.stage}` : ''} · rodando há {duration(Math.max(0, elapsed))} · isolado em sandbox
              </div>
            </div>
            <div className="workload-pct num">{pct(w.progress * 100)}</div>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.round(w.progress * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </section>
  );
}
