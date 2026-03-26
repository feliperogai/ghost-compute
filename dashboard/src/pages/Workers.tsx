import { useMemo, useState } from 'react';
import { Badge, ErrorNotice, Meter, StateBadge, tempTone } from '../components/ui';
import { ago, duration, mb, n, pct } from '../format';
import type { WorkerRow } from '../types';
import { useApi } from '../useApi';
import { Updated } from './common';

export function Workers() {
  const q = useApi<{ items: WorkerRow[] }>('/v1/dashboard/workers', 10_000);
  const [text, setText] = useState('');
  const [state, setState] = useState('all');
  const rows = useMemo(
    () =>
      (q.data?.items ?? []).filter(
        (w) =>
          (state === 'all' || (state === 'online' ? w.online : state === 'offline' ? !w.online : w.state === state)) &&
          (!text || `${w.name} ${w.id} ${w.hardware.cpu} ${w.hardware.gpus.map((g) => g.name).join(' ')}`.toLowerCase().includes(text.toLowerCase())),
      ),
    [q.data, text, state],
  );
  return (
    <>
      <div className="filters">
        <input className="btn" style={{ minWidth: 240 }} placeholder="Buscar nome, id, CPU, GPU…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Buscar workers" />
        <select className="btn" value={state} onChange={(e) => setState(e.target.value)} aria-label="Filtrar por estado">
          <option value="all">Todos</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="running">Executando</option>
          <option value="available">Disponível</option>
          <option value="paused">Pausado</option>
          <option value="stopped">Parado</option>
        </select>
        <Updated at={q.updatedAt} loading={q.loading} onRefresh={q.reload} />
      </div>
      <ErrorNotice error={q.error} />
      <div className={`card ${q.loading && q.data ? 'dim' : ''}`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Estado</th>
                <th>Hardware</th>
                <th className="num">Performance</th>
                <th>Temperatura</th>
                <th>CPU (ghost)</th>
                <th className="num">RAM</th>
                <th className="num">GPU</th>
                <th className="num">Jobs ativos</th>
                <th className="num">Uptime</th>
                <th className="num">Heartbeat</th>
                <th className="num">24 h ok / falhas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="clickable" onClick={() => (location.hash = `#/workers/${w.id}`)}>
                  <td>
                    <a href={`#/workers/${w.id}`} onClick={(e) => e.stopPropagation()}>
                      {w.name}
                    </a>
                    <div className="mono muted">{w.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    <StateBadge state={w.state} />
                  </td>
                  <td>
                    <div>{w.hardware.cpu ?? '—'}</div>
                    <div className="muted">
                      {w.hardware.threads ?? '?'} threads · {mb(w.hardware.ramMb)}
                      {w.hardware.gpus.length ? ` · ${w.hardware.gpus.map((g) => g.name).join(', ')}` : ''}
                    </div>
                  </td>
                  <td className="num">
                    {w.performance ? (
                      <>
                        <div>{n(w.performance.overall, 0)}</div>
                        <div className="muted">{w.performance.verified ? `${n(w.performance.inferenceItemsPerSec, 0)} img/s` : 'não verificado'}</div>
                      </>
                    ) : (
                      <span className="muted">sem calibração</span>
                    )}
                  </td>
                  <td>
                    {w.usage.temperatureC === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <Badge tone={tempTone(w.usage.temperatureC, w.capacity?.maxTemperatureC)}>{n(w.usage.temperatureC)} °C</Badge>
                    )}
                  </td>
                  <td style={{ minWidth: 110 }}>
                    <Meter value={w.usage.cpuPercent} label={`CPU de ${w.name}`} />
                    <div className="muted num">
                      {pct(w.usage.cpuPercent)} ({pct(w.usage.ghostCpuPercent)})
                    </div>
                  </td>
                  <td className="num">{mb(w.usage.ramUsedMb)}</td>
                  <td className="num">{pct(w.usage.gpuPercent)}</td>
                  <td className="num">{w.activeJobs}</td>
                  <td className="num">{duration(w.uptimeS)}</td>
                  <td className="num" title={w.lastSeenAt ?? ''}>{ago(w.lastSeenAt)}</td>
                  <td className="num">
                    {w.last24h.completed} / <span className={w.last24h.failed ? 'err' : ''}>{w.last24h.failed}</span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="muted">
                    {q.data ? 'Nenhum worker corresponde ao filtro.' : 'Carregando…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
