import { useEffect, useState } from 'react';
import { getToken } from '../api';

interface Ev {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

/** Tail of the control plane's event stream (WebSocket), newest first. */
export function LiveEvents({ filter }: { filter?: (e: Ev) => boolean }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState('conectando…');
  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`);
      ws.onopen = () => {
        ws!.send(JSON.stringify({ type: 'auth', token: getToken() }));
        setStatus('conectado');
      };
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data));
          if (msg.type === 'event' && msg.event && (!filter || filter(msg.event))) {
            setEvents((prev) => [msg.event as Ev, ...prev].slice(0, 200));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus('desconectado; tentando de novo…');
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [filter]);
  return (
    <div className="card">
      <div className="chart-head">
        <h3>Fluxo de eventos</h3>
        <span className="sub">{status}</span>
      </div>
      <div className="events" aria-live="off">
        {events.length === 0 && <div className="muted">Aguardando eventos…</div>}
        {events.map((e, i) => (
          <div key={i} title={JSON.stringify(e.data)}>
            <span className="muted">{new Date(e.ts).toLocaleTimeString('pt-BR')}</span> {e.type} <span className="muted">{JSON.stringify(e.data)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
