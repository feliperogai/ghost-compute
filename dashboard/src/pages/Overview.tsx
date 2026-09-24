import { useState } from 'react';
import type { Range } from '../api';
import { LineChart } from '../components/LineChart';
import { ErrorNotice, RangePicker, StatTile } from '../components/ui';
import { compact, mb, n, pct } from '../format';
import type { History, Overview as OverviewData } from '../types';
import { useApi } from '../useApi';
import { ErrorsTable, RANGE_MS, Updated } from './common';
import { LiveEvents } from './LiveEvents';

export function Overview() {
  const [range, setRange] = useState<Range>('24h');
  const o = useApi<OverviewData>('/v1/dashboard/overview', 10_000);
  const h = useApi<History>(`/v1/dashboard/history?range=${range}`, 30_000);
  const to = Date.now();
  const from = to - RANGE_MS[range];
  const d = o.data;
  const net = (h.data?.network ?? []).map((r) => ({ ...r, ramGb: r.ramMb / 1024, vramGb: r.vramMb / 1024 }));
  const apiPts = h.data?.api ?? [];
  const chart = { from, to };

  return (
    <>
      <div className="filters">
        <RangePicker value={range} onChange={setRange} />
        <Updated at={o.updatedAt} loading={o.loading || h.loading} onRefresh={() => (o.reload(), h.reload())} />
      </div>
      <ErrorNotice error={o.error ?? h.error} />
      {d && (
        <div className={o.loading ? '' : ''}>
          <h2>Rede</h2>
          <div className="grid tiles">
            <StatTile
              label="Workers online"
              value={n(d.network.workersOnline, 0)}
              sub={Object.entries(d.network.workersByState)
                .filter(([s]) => s !== 'offline')
                .map(([s, c]) => `${c} ${s}`)
                .join(' · ') || 'nenhum'}
            />
            <StatTile label="Workers offline" value={n(d.network.workersOffline, 0)} />
            <StatTile label="CPU total" value={n(d.network.cpu.offeredCores)} unit="núcleos" sub={`oferecidos · ${n(d.network.cpu.threads, 0)} threads instaladas`} />
            <StatTile label="GPU total" value={n(d.network.gpu.shared, 0)} unit="compartilhadas" sub={`${n(d.network.gpu.installed, 0)} instaladas`} />
            <StatTile label="RAM total" value={mb(d.network.ram.offeredMb)} sub={`oferecida · ${mb(d.network.ram.installedMb)} instalada`} />
            <StatTile label="VRAM total" value={mb(d.network.vram.offeredMb)} sub={`oferecida · ${mb(d.network.vram.installedMb)} instalada`} />
          </div>

          <h2>Jobs</h2>
          <div className="grid tiles">
            <StatTile label="Na fila" value={compact(d.jobs.queued)} sub={d.jobs.pendingReasons[0]?.reason ?? 'sem pendências'} />
            <StatTile label="Executando" value={compact(d.jobs.running)} sub={`${d.jobs.assigned} aguardando aceite`} />
            <StatTile label="Concluídos" value={compact(d.jobs.completed)} sub={`${d.jobs.lastHour.completed} na última hora`} />
            <StatTile label="Falharam" value={compact(d.jobs.failed + d.jobs.timeout)} sub={`${d.jobs.timeout} por timeout · ${d.jobs.lastHour.failed} na última hora`} />
          </div>

          <h2>Sistema</h2>
          <div className="grid tiles">
            <StatTile label="Erros de servidor (5 min)" value={n(d.system.api.errors5xx, 0)} sub={`${pct(d.system.api.errorRate * 100)} das requisições · ${d.system.api.errors4xx} erros 4xx`} />
            <StatTile label="Falhas de tentativa (1 h)" value={n(d.system.attemptsLastHour.failed, 0)} sub={`${pct(d.system.attemptsLastHour.failureRate * 100)} das tentativas`} />
            <StatTile label="Latência da API (p50)" value={n(d.system.api.latencyP50Ms)} unit="ms" sub={`p95 ${n(d.system.api.latencyP95Ms)} ms · p99 ${n(d.system.api.latencyP99Ms)} ms`} />
            <StatTile label="Throughput" value={n(d.system.throughputPerMinute)} unit="jobs/min" sub={`${n(d.system.api.requestsPerMinute)} requisições/min`} />
          </div>
        </div>
      )}

      <div className={h.loading ? 'dim' : ''}>
        <h2>Histórico · rede</h2>
        <div className="grid charts">
          <LineChart title="Workers" integer series={[{ key: 'workersOnline', label: 'online', slot: 1 }, { key: 'workersOffline', label: 'offline', slot: 2 }]} points={net} format={(v) => n(v, 0)} {...chart} />
          <LineChart title="CPU oferecida" subtitle="núcleos" series={[{ key: 'cpuCores', label: 'núcleos', slot: 1 }]} points={net} format={(v) => n(v)} {...chart} />
          <LineChart title="RAM oferecida" subtitle="GB" series={[{ key: 'ramGb', label: 'RAM', slot: 1 }]} points={net} format={(v) => `${n(v)} GB`} {...chart} />
          <LineChart title="GPUs compartilhadas" integer series={[{ key: 'gpus', label: 'GPUs', slot: 1 }]} points={net} format={(v) => n(v)} {...chart} />
          <LineChart title="VRAM oferecida" subtitle="GB" series={[{ key: 'vramGb', label: 'VRAM', slot: 1 }]} points={net} format={(v) => `${n(v)} GB`} {...chart} />
        </div>
        <h2>Histórico · jobs</h2>
        <div className="grid charts">
          <LineChart title="Fila e execução" integer subtitle="jobs" series={[{ key: 'jobsQueued', label: 'na fila', slot: 1 }, { key: 'jobsRunning', label: 'executando', slot: 2 }]} points={net} format={(v) => n(v)} {...chart} />
          <LineChart title="Conclusões e falhas" subtitle="por minuto" series={[{ key: 'completedPerMin', label: 'concluídos', slot: 1 }, { key: 'failedPerMin', label: 'falhas', slot: 2 }]} points={net} format={(v) => n(v)} {...chart} />
          <LineChart title="Espera na fila" subtitle="criação → atribuição" series={[{ key: 'queueWaitP50S', label: 'p50', slot: 1 }, { key: 'queueWaitP95S', label: 'p95', slot: 2 }]} points={net} format={(v) => `${n(v)} s`} {...chart} />
        </div>
        <h2>Histórico · sistema</h2>
        <div className="grid charts">
          <LineChart title="Latência da API" series={[{ key: 'latencyP50Ms', label: 'p50', slot: 1 }, { key: 'latencyP95Ms', label: 'p95', slot: 2 }]} points={apiPts} format={(v) => `${n(v)} ms`} {...chart} />
          <LineChart title="Requisições" subtitle="por minuto" series={[{ key: 'requestsPerMin', label: 'requisições', slot: 1 }]} points={apiPts} format={(v) => compact(v)} {...chart} />
          <LineChart title="Erros da API" subtitle="por minuto" series={[{ key: 'errors5xxPerMin', label: '5xx', slot: 1 }, { key: 'errors4xxPerMin', label: '4xx', slot: 2 }]} points={apiPts} format={(v) => n(v)} {...chart} />
        </div>
      </div>

      {d && (
        <>
          <h2>Por que há jobs na fila</h2>
          <div className="card">
            {d.jobs.pendingReasons.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>Nenhum job esperando.</p>
            ) : (
              <table>
                <tbody>
                  {d.jobs.pendingReasons.map((p) => (
                    <tr key={p.reason}>
                      <td className="num" style={{ width: 60 }}>{p.jobs}</td>
                      <td className="mono">{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <h2>
            Erros recentes · <a href="#/errors">ver todos</a>
          </h2>
          <div className="card">
            <ErrorsTable items={d.recentErrors} />
          </div>
        </>
      )}
      <h2>Eventos ao vivo</h2>
      <LiveEvents />
    </>
  );
}
