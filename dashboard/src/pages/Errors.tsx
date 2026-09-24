import { useState } from 'react';
import { ErrorNotice } from '../components/ui';
import type { ErrorItem } from '../types';
import { useApi } from '../useApi';
import { ErrorsTable, Updated } from './common';

export function Errors() {
  const [kind, setKind] = useState('');
  const q = useApi<{ items: ErrorItem[] }>(`/v1/dashboard/errors?limit=200${kind ? `&kind=${kind}` : ''}`, 15_000);
  return (
    <>
      <h1>Erros</h1>
      <p className="secondary" style={{ marginTop: 0 }}>
        Erros de servidor (com request id para os logs), tentativas que falharam e calibrações reprovadas, do mais recente ao mais antigo.
      </p>
      <div className="filters">
        <select className="btn" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo de erro">
          <option value="">Todos os tipos</option>
          <option value="api">API (5xx)</option>
          <option value="attempt">Tentativas</option>
          <option value="calibration">Calibrações</option>
        </select>
        <Updated at={q.updatedAt} loading={q.loading} onRefresh={q.reload} />
      </div>
      <ErrorNotice error={q.error} />
      <div className={`card ${q.loading && q.data ? 'dim' : ''}`}>
        <ErrorsTable items={q.data?.items ?? []} />
      </div>
    </>
  );
}
