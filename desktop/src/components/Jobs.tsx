import type { Status } from '../types';
import { duration, pct, relativeTime, taskStatusText } from '../text';

export function Jobs({ status }: { status: Status }) {
  const recent = status.stats?.recent ?? [];
  const now = Date.parse(status.generatedAt);
  return (
    <div>
      <section className="panel" aria-labelledby="active-title">
        <h2 className="panel-title" id="active-title">Em execução agora</h2>
        {status.workloads.length === 0 ? (
          <p className="empty">Nenhum trabalho em execução neste computador.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Trabalho</th>
                <th>Módulo</th>
                <th>Etapa</th>
                <th>Progresso</th>
                <th>Início</th>
              </tr>
            </thead>
            <tbody>
              {status.workloads.map((w) => (
                <tr key={w.leaseId}>
                  <td>{w.jobName}</td>
                  <td>{w.module.name} {w.module.version}</td>
                  <td>{w.stage ?? '—'}</td>
                  <td className="num">{pct(w.progress * 100)}</td>
                  <td>{relativeTime(w.startedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel" aria-labelledby="recent-title">
        <h2 className="panel-title" id="recent-title">Histórico recente</h2>
        {recent.length === 0 ? (
          <p className="empty">Nenhum trabalho ainda. Quando este computador contribuir, o histórico aparece aqui.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Trabalho</th>
                <th>Módulo</th>
                <th>Tarefa</th>
                <th>Resultado</th>
                <th>Duração</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => {
                const d =
                  t.acceptedAt && t.finishedAt ? (Date.parse(t.finishedAt) - Date.parse(t.acceptedAt)) / 1000 : null;
                return (
                  <tr key={t.leaseId}>
                    <td>{t.jobName}</td>
                    <td>{t.module.name} {t.module.version}</td>
                    <td className="num">#{t.taskIndex}</td>
                    <td><span className={`pill ${t.status}`}>{taskStatusText(t.status)}</span></td>
                    <td className="num">{d == null ? '—' : duration(d)}</td>
                    <td>{relativeTime(t.finishedAt ?? t.offeredAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
