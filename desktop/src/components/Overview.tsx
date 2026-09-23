import type { Status } from '../types';
import { celsius, connectionText, pct, relativeTime, size } from '../text';
import { Meter } from './Meter';

const TEMP_MIN = 20;
const TEMP_MAX = 110;
const tempPos = (c: number) => ((c - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 100;

export function Resources({ status }: { status: Status }) {
  const { avg } = status.usage;
  const l = status.limits;
  const hw = status.hardware;

  const cpuOwner = Math.max(0, avg.cpuPercent - avg.cpuGhostPercent);
  const ramTotal = avg.ramTotalMb || hw.ramMb;
  const ramOwner = Math.max(0, avg.ramUsedMb - avg.ramGhostMb);
  const vramTotal = hw.gpus.reduce((s, g) => s + (g.vramMb ?? 0), 0);
  const gpuName = hw.gpus.map((g) => g.name).join(', ');
  const gpuShared = l.max_gpu_percent > 0;
  const temp = status.usage.maxTemperatureC;

  return (
    <section className="panel" aria-labelledby="res-title">
      <h2 className="panel-title" id="res-title">
        Recursos deste computador
      </h2>
      <div className="legend" aria-hidden>
        <span><i className="ghost" />ghost</span>
        <span><i className="owner" />Você e outros apps</span>
        <span><i className="cap" />Limite que você definiu</span>
      </div>

      <Meter
        name="CPU"
        sub={`${hw.cpu.model} · ${hw.cpu.cores} núcleos / ${hw.cpu.threads} threads`}
        value={pct(avg.cpuPercent)}
        owner={cpuOwner}
        ghost={avg.cpuGhostPercent}
        cap={l.max_cpu_percent}
        foot={<>ghost <b className="num">{pct(avg.cpuGhostPercent)}</b> · você <b className="num">{pct(cpuOwner)}</b></>}
        footRight={<>Disponibilizado: até <b className="num">{pct(l.max_cpu_percent)}</b></>}
      />

      <Meter
        name="GPU"
        sub={gpuName || 'Nenhuma GPU detectada'}
        value={avg.gpuPercent == null ? 'Sem leitura' : pct(avg.gpuPercent)}
        muted={avg.gpuPercent == null}
        owner={avg.gpuPercent ?? 0}
        ghost={0}
        cap={hw.gpus.length ? l.max_gpu_percent : null}
        capNone={!gpuShared}
        foot={avg.gpuPercent == null ? 'Este computador não informa o uso da GPU.' : <>Uso total <b className="num">{pct(avg.gpuPercent)}</b></>}
        footRight={gpuShared ? <>Disponibilizado: até <b className="num">{pct(l.max_gpu_percent)}</b></> : 'Não compartilhada'}
      />

      <Meter
        name="RAM"
        value={`${size(avg.ramUsedMb)} de ${size(ramTotal)}`}
        owner={(ramOwner / ramTotal) * 100}
        ghost={(avg.ramGhostMb / ramTotal) * 100}
        cap={(l.max_ram_mb / ramTotal) * 100}
        foot={<>ghost <b className="num">{size(avg.ramGhostMb)}</b> · você <b className="num">{size(ramOwner)}</b></>}
        footRight={<>Disponibilizado: até <b className="num">{size(l.max_ram_mb)}</b></>}
      />

      <Meter
        name="VRAM"
        sub={vramTotal ? `${size(vramTotal)} dedicada` : undefined}
        value={
          vramTotal && avg.gpuMemoryUsedMb != null
            ? `${size(avg.gpuMemoryUsedMb)} de ${size(vramTotal)}`
            : vramTotal
              ? size(vramTotal)
              : 'Não informado'
        }
        muted={!vramTotal || avg.gpuMemoryUsedMb == null}
        owner={vramTotal && avg.gpuMemoryUsedMb != null ? (avg.gpuMemoryUsedMb / vramTotal) * 100 : 0}
        cap={null}
        foot={vramTotal ? 'Memória de vídeo em uso' : 'Sem GPU dedicada ou sem leitura.'}
        footRight={gpuShared ? 'Usada só com a GPU compartilhada' : 'Não compartilhada'}
      />

      <Meter
        name="Temperatura"
        value={temp == null ? 'Sem sensor' : celsius(temp)}
        muted={temp == null}
        heat={temp == null ? undefined : tempPos(temp)}
        hot={temp != null && temp >= l.max_temperature_c - 5}
        cap={tempPos(l.max_temperature_c)}
        over={temp != null && temp > l.max_temperature_c}
        foot={temp == null ? 'Este computador não informa a temperatura; o limite não pode ser aplicado.' : 'Sensor mais quente nos últimos 30 s'}
        footRight={<>Pausa acima de <b className="num">{celsius(l.max_temperature_c)}</b></>}
      />
    </section>
  );
}

export function SidePanels({ status }: { status: Status }) {
  const s = status.stats;
  const conn = connectionText(status.connection.status);
  let host = status.agent.serverUrl;
  try {
    host = new URL(status.agent.serverUrl).host;
  } catch {
    /* keep raw */
  }
  return (
    <div>
      <section className="panel" aria-labelledby="cred-title">
        <h2 className="panel-title" id="cred-title">Créditos internos</h2>
        <div className="stat-big num" data-testid="credits">
          {s ? s.credits.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'}
          <span className="stat-unit">créditos</span>
        </div>
        <p className="note">1 crédito = 1 minuto de processamento concluído. Uso interno da rede, sem valor monetário.</p>
      </section>

      <section className="panel" aria-labelledby="jobs-title">
        <h2 className="panel-title" id="jobs-title">Trabalhos</h2>
        <div className="counts">
          <div className="count">
            <b className="num" data-testid="jobs-active">{status.workloads.length}</b>
            <span>ativos</span>
          </div>
          <div className="count">
            <b className="num" data-testid="jobs-done">{s?.tasks.succeeded ?? '—'}</b>
            <span>concluídos</span>
          </div>
          <div className="count">
            <b className="num">{s ? s.tasks.failed : '—'}</b>
            <span>falharam</span>
          </div>
        </div>
        {s && s.tasks.preempted > 0 && (
          <p className="note">{s.tasks.preempted} interrompidos (computador ocupado, desligado ou sem conexão) e enviados para outro computador.</p>
        )}
      </section>

      <section className="panel" aria-labelledby="conn-title">
        <h2 className="panel-title" id="conn-title">Conexão</h2>
        <dl className="kv">
          <dt>Servidor</dt>
          <dd>
            <span className={`dot ${conn.ok ? 'ok' : 'bad'}`} style={{ display: 'inline-block', marginRight: 6 }} />
            {conn.label}
          </dd>
          <dt>Endereço</dt>
          <dd>{host}</dd>
          <dt>Último contato</dt>
          <dd className="num">{relativeTime(status.connection.lastContactAt, Date.parse(status.generatedAt))}</dd>
          <dt>Computador</dt>
          <dd>{status.agent.name}</dd>
          <dt>Agente</dt>
          <dd className="num">v{status.agent.version}</dd>
        </dl>
        {status.connection.lastError && !conn.ok && <p className="error-text">{status.connection.lastError}</p>}
      </section>
    </div>
  );
}
