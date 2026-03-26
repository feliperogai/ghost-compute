const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export const n = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : (digits === 0 ? nf0 : nf1).format(v);

/** 1.284 / 12,9 mil / 4,2 mi */
export function compact(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${nf1.format(v / 1e6)} mi`;
  if (a >= 1e4) return `${nf1.format(v / 1e3)} mil`;
  return nf1.format(v);
}

export function mb(v: number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return v >= 1024 ? `${nf1.format(v / 1024)} GB` : `${nf0.format(v)} MB`;
}

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf0.format(v)}%`);

export function duration(s: number | null | undefined) {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${nf0.format(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 5 ? 'agora' : `há ${duration(s)}`;
}

export const time = (iso: string, withDate = false) =>
  new Date(iso).toLocaleString('pt-BR', withDate ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
