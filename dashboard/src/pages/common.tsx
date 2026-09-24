import type { Range } from '../api';
import { ago, dateTime } from '../format';
import type { ErrorItem } from '../types';
import { Badge } from '../components/ui';

export const RANGE_MS: Record<Range, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

export function Updated({ at, loading, onRefresh }: { at: number | null; loading: boolean; onRefresh: () => void }) {
  return (
    <>
      <span className="updated" aria-live="polite">
        {loading ? 'atualizando…' : at ? `atualizado ${ago(new Date(at).toISOString())}` : ''}
      </span>
      <button className="btn" onClick={onRefresh}>
        Atualizar
      </button>
    </>
  );
}

const KIND: Record<ErrorItem['kind'], string> = { api: 'API', attempt: 'Tentativa', calibration: 'Calibração' };

export function ErrorsTable({ items, showWorker = true }: { items: ErrorItem[]; showWorker?: boolean }) {
  if (!items.length) return <p className="muted">Nenhum erro registrado.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Quando</th>
            <th>Tipo</th>
            {showWorker && <th>Worker</th>}
            <th>Origem</th>
            <th>Código</th>
            <th>Mensagem</th>
            <th>Ref.</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e, i) => (
            <tr key={`${e.kind}-${e.ref}-${i}`}>
              <td title={dateTime(e.at)}>{ago(e.at)}</td>
              <td>
                <Badge tone={e.kind === 'api' ? 'critical' : e.kind === 'attempt' ? 'serious' : 'warning'}>{KIND[e.kind]}</Badge>
              </td>
              {showWorker && <td>{e.workerId ? <a href={`#/workers/${e.workerId}`}>{e.workerName ?? e.workerId.slice(0, 8)}</a> : '—'}</td>}
              <td>{e.source}</td>
              <td className="mono">{e.code}</td>
              <td className="err">{e.message || '—'}</td>
              <td className="mono muted" title={e.jobId ? `job ${e.jobId}` : undefined}>
                {e.ref?.slice(0, 13) ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
