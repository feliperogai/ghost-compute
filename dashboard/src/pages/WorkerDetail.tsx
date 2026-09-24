import { useCallback, useState } from 'react';
import type { Range } from '../api';
import { LineChart } from '../components/LineChart';
import { Badge, ErrorNotice, RangePicker, StatTile, StateBadge, tempTone } from '../components/ui';
import { ago, dateTime, duration, mb, n, pct } from '../format';
import type { ErrorItem, WorkerDetail as Detail } from '../types';
import { useApi } from '../useApi';
import { ErrorsTable, RANGE_MS, Updated } from './common';
import { LiveEvents } from './LiveEvents';

const ASSIGN_TONE: Record<string, 'good' | 'warning' | 'serious' | 'critical' | 'neutral'> = {
  completed: 'good',
  running: 'good',
  assigned: 'warning',
  rejected: 'neutral',
  cancelled: 'neutral',
  expired: 'serious',
  lost: 'serious',
  failed: 'critical',
  timeout: 'critical',
};

export function WorkerDetail({ id }: { id: string }) {
  const [range, setRange] = useState<Range>('24h');
  const q = useApi<Detail>(`/v1/dashboard/workers/${id}?range=${range}`, 15_000);
  const errs = useApi<{ items: ErrorItem[] }>(`/v1/dashboard/errors?workerId=${id}&limit=50`, 30_000);
  const onlyThis = useCallback((e: { data: Record<string, unknown> }) => e.data.workerId === id, [id]);
  const d = q.data;
  const w = d?.worker;
  const to = Date.now();
  const chart = { from: to - RANGE_MS[range], to };
  const gb = (v: number | null) => (v === null ? null : v / 1024);
  const pts = (d?.history.points ?? []).map((x) => ({ ...x, ramUsedGb: gb(x.ramUsedMb), ramGhostGb: gb(x.ramGhostMb) }));
  const p = d?.profile;

  return (
    <>
      <p>
        <a href="#/workers">← Workers</a>
      </p>
      <ErrorNotice error={q.error} />
      {w && (
        <>
          <h1>{w.name}</h1>
          <p className="secondary" style={{ marginTop: 0 }}>
            <StateBadge state={w.state} /> · <span className="mono">{w.id}</span> · agente {w.agentVersion ?? '?'} · heartbeat {ago(w.lastSeenAt)} · uptime {duration(w.uptimeS)}
          </p>
          <div className="filters">
            <RangePicker value={range} onChange={setRange} />
            <Updated at={q.updatedAt} loading={q.loading} onRefresh={q.reload} />
          </div>

          <div className="grid tiles">
            <StatTile label="CPU" value={pct(w.usage.cpuPercent)} sub={`ghost ${pct(w.usage.ghostCpuPercent)} · oferece ${n(w.capacity?.cpuCores)} núcleos`} />
            <StatTile label="RAM usada" value={mb(w.usage.ramUsedMb)} sub={`ghost ${mb(w.usage.ramGhostMb)} · de ${mb(w.hardware.ramMb)}`} />
            <StatTile label="GPU" value={pct(w.usage.gpuPercent)} sub={w.hardware.gpus.map((g) => `${g.name} (${mb(g.vramMb)})`).join(', ') || 'sem GPU'} />
            <StatTile
              label="Temperatura"
              value={w.usage.temperatureC === null ? '—' : <Badge tone={tempTone(w.usage.temperatureC, w.capacity?.maxTemperatureC)}>{n(w.usage.temperatureC)} °C</Badge>}
              sub={`limite do dono ${n(w.capacity?.maxTemperatureC, 0)} °C`}
            />
            <StatTile label="Jobs ativos" value={w.activeJobs} sub={`24 h: ${w.last24h.completed} concluídos, ${w.last24h.failed} falhas`} />
            <StatTile
              label="Performance"
              value={w.performance ? n(w.performance.overall, 0) : '—'}
              sub={w.performance ? `${w.performance.verified ? 'verificado' : 'NÃO verificado'} · calibrado ${ago(w.performance.calibratedAt)}` : 'sem calibração'}
            />
          </div>

          <h2>Histórico</h2>
          <div className={`grid charts ${q.loading ? 'dim' : ''}`}>
            <LineChart title="CPU" subtitle="% da máquina" series={[{ key: 'cpuPercent', label: 'total', slot: 1 }, { key: 'ghostCpuPercent', label: 'ghost', slot: 2 }]} points={pts} yMax={100} format={(v) => `${n(v, 0)}%`} {...chart} />
            <LineChart title="RAM" subtitle="GB" series={[{ key: 'ramUsedGb', label: 'usada', slot: 1 }, { key: 'ramGhostGb', label: 'ghost', slot: 2 }]} points={pts} format={(v) => `${n(v)} GB`} {...chart} />
            <LineChart title="GPU" subtitle="% de uso" series={[{ key: 'gpuPercent', label: 'GPU', slot: 1 }]} points={pts} yMax={100} format={(v) => `${n(v, 0)}%`} {...chart} />
            <LineChart title="Temperatura" subtitle="°C" series={[{ key: 'temperatureC', label: 'média', slot: 1 }, { key: 'temperatureMaxC', label: 'máxima', slot: 2 }]} points={pts} yMax={Math.max(90, w.capacity?.maxTemperatureC ?? 0)} format={(v) => `${n(v, 0)} °C`} {...chart} />
            <LineChart title="Jobs ativos" integer series={[{ key: 'activeJobs', label: 'jobs', slot: 1 }]} points={pts} format={(v) => n(v)} {...chart} />
            <LineChart title="Tempo compartilhando" subtitle="fração do intervalo" series={[{ key: 'sharingFraction', label: 'compartilhando', slot: 1 }]} points={pts} yMax={1} format={(v) => `${n(v * 100, 0)}%`} {...chart} />
          </div>

          <h2>Performance (calibração)</h2>
          <div className="grid charts">
            <div className="card">
              {p ? (
                <dl className="kv">
                  <dt>Scores</dt>
                  <dd className="num">
                    geral {p.scores?.overall} · CPU {p.scores?.cpu} · GPU {p.scores?.gpu} · inferência {p.scores?.inference} · rede {p.scores?.network} · disco {p.scores?.storage}
                  </dd>
                  <dt>CPU</dt>
                  <dd>
                    {p.cpu?.model ?? '—'} · {n(p.cpu?.singleThread?.hashesPerSec, 0)} hash/s · {n(p.cpu?.singleThread?.matmulMflops, 0)} MFLOPS · paralelo {n(p.cpu?.parallel?.speedup)}×
                  </dd>
                  <dt>GPU</dt>
                  <dd>{p.gpu ? `${p.gpu.name ?? '?'} · ${n(p.gpu.matmulGflops)} GFLOPS · VRAM livre ${mb(p.gpu.vramAvailableMb)} · ${p.gpu.verified ? 'verificada' : 'NÃO verificada'}` : 'não testada'}</dd>
                  <dt>Inferência</dt>
                  <dd>
                    CPU {n(p.inference?.cpu?.itemsPerSec, 0)} img/s ({n(p.inference?.cpu?.avgLatencyMs)} ms/img)
                    {p.inference?.gpu ? ` · GPU ${n(p.inference.gpu.itemsPerSec, 0)} img/s` : ''} · melhor: {p.inference?.best ?? '—'}
                  </dd>
                  <dt>Rede</dt>
                  <dd>
                    latência {n(p.network?.latencyMs?.median)} ms (p95 {n(p.network?.latencyMs?.p95)}) · download {n(p.network?.downloadMbps)} Mbps · upload {n(p.network?.uploadMbps)} Mbps
                  </dd>
                  <dt>Disco</dt>
                  <dd>{p.storage ? `escrita ${n(p.storage.seqWriteMBps)} MB/s · leitura ${n(p.storage.seqReadMBps)} MB/s · fsync ${n(p.storage.syncLatencyMs)} ms` : '—'}</dd>
                  <dt>Observado</dt>
                  <dd>
                    {Object.entries(d.observed).map(([t, o]) => `${t}: ${n(o.itemsPerSec)} itens/s (${o.samples} amostras)`).join(' · ') || 'sem jobs reais ainda'}
                  </dd>
                  {p.issues?.length ? (
                    <>
                      <dt>Problemas</dt>
                      <dd className="err mono">{p.issues.join(', ')}</dd>
                    </>
                  ) : null}
                </dl>
              ) : (
                <p className="muted">Este worker ainda não foi calibrado.</p>
              )}
            </div>
            <div className="card">
              <h3>Calibrações</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pedida</th>
                      <th>Motivo</th>
                      <th>Estado</th>
                      <th>Problemas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.calibrations.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">Nenhuma calibração ainda.</td>
                      </tr>
                    )}
                    {d.calibrations.map((c) => (
                      <tr key={c.id}>
                        <td title={dateTime(c.requestedAt)}>{ago(c.requestedAt)}</td>
                        <td>{c.reason}</td>
                        <td>
                          <Badge tone={c.status === 'COMPLETED' ? 'good' : c.status === 'REQUESTED' ? 'warning' : 'critical'}>{c.status}</Badge>
                        </td>
                        <td className="mono err">{[...c.issues, c.error].filter(Boolean).join(', ') || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <h2>Tentativas recentes</h2>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Atribuída</th>
                    <th>Job</th>
                    <th>Tipo</th>
                    <th className="num">Tent.</th>
                    <th>Estado</th>
                    <th className="num">Duração</th>
                    <th className="num">Score</th>
                    <th>Erro</th>
                  </tr>
                </thead>
                <tbody>
                  {d.assignments.map((a) => (
                    <tr key={a.id}>
                      <td title={dateTime(a.assignedAt)}>{ago(a.assignedAt)}</td>
                      <td>
                        {a.jobName ?? '—'} <span className="mono muted">{a.jobId.slice(0, 8)}</span>
                      </td>
                      <td>{a.type}</td>
                      <td className="num">{a.attempt}</td>
                      <td>
                        <Badge tone={ASSIGN_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                      </td>
                      <td className="num">{a.durationS === null ? '—' : `${n(a.durationS)} s`}</td>
                      <td className="num">{n(a.score, 2)}</td>
                      <td className="err">{a.error ?? ''}</td>
                    </tr>
                  ))}
                  {d.assignments.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted">Nenhuma tentativa ainda.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <h2>Decisões do scheduler</h2>
          <div className="card">
            {d.decisions.length === 0 && <p className="muted">Nenhum job foi atribuído a este worker.</p>}
            {d.decisions.map((x, i) => (
              <p key={i} style={{ margin: '0 0 8px' }}>
                <span className="muted">{ago(x.at)} · job <span className="mono">{x.jobId.slice(0, 8)}</span> · score {n(x.score, 2)}</span>
                <br />
                {x.summary}
              </p>
            ))}
          </div>

          <h2>Erros deste worker</h2>
          <div className="card">
            <ErrorsTable items={errs.data?.items ?? []} showWorker={false} />
          </div>

          <h2>Eventos de jobs</h2>
          <div className="card events">
            {d.events.length === 0 && <div className="muted">Nenhum evento de job com este worker.</div>}
            {d.events.map((e) => (
              <div key={e.id} title={JSON.stringify(e.payload)}>
                <span className="muted">{dateTime(e.at)}</span> {e.type} <span className="muted">job {e.jobId.slice(0, 8)} {JSON.stringify(e.payload)}</span>
              </div>
            ))}
          </div>

          <h2>Ao vivo (este worker)</h2>
          <LiveEvents filter={onlyThis} />

          <h2>Dados brutos</h2>
          <details className="card">
            <summary>Hardware, capacidade, último uso, tipos de workload</summary>
            <pre className="json">{JSON.stringify(d.raw, null, 2)}</pre>
          </details>
        </>
      )}
      {!w && !q.error && <p className="muted">Carregando…</p>}
    </>
  );
}
