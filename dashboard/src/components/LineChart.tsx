// Time-series line chart: one y-axis, 2px lines, hairline grid, crosshair + tooltip
// listing every series, legend for ≥2 series, table view for every value.
import { useEffect, useMemo, useRef, useState } from 'react';
import { time } from '../format';

export interface Series {
  key: string;
  label: string;
  /** Categorical slot, fixed per entity (1..3 are validated all-pairs). */
  slot: 1 | 2 | 3;
}
export type Point = { t: string } & Record<string, number | null | string>;

interface Props {
  title: string;
  subtitle?: string;
  series: Series[];
  points: Point[];
  format: (v: number) => string;
  /** Fixed top of the y-axis (e.g. 100 for percentages). */
  yMax?: number;
  /** Counts: ticks on whole numbers only. */
  integer?: boolean;
  from: number;
  to: number;
  height?: number;
}

const PAD = { top: 8, right: 12, bottom: 22, left: 44 };

/** Round tick step (1, 2, 2.5 or 5 × 10^k) for about `count` intervals up to `v`. */
export function niceScale(v: number, count = 4, integer = false): { max: number; step: number } {
  const raw = Math.max(v, integer ? 1 : 1e-9) / count;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const mults = integer && exp < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = mults.map((m) => m * exp).find((s) => s >= raw) ?? 10 * exp;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(v / step) * step || step, step };
}

const color = (slot: number) => `var(--series-${slot})`;
const val = (p: Point, key: string) => (typeof p[key] === 'number' ? (p[key] as number) : null);

export function LineChart({ title, subtitle, series, points, format, yMax, integer = false, from, to, height = 170 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => points.map((p) => ({ p, x: Date.parse(p.t) })).sort((a, b) => a.x - b.x), [points]);
  const { max, step } = useMemo(() => {
    if (yMax !== undefined) return niceScale(yMax, 4, integer);
    let m = 0;
    for (const { p } of pts) for (const s of series) m = Math.max(m, val(p, s.key) ?? 0);
    return niceScale(m * 1.05, 4, integer);
  }, [pts, series, yMax, integer]);

  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + ((x - from) / Math.max(1, to - from)) * iw;
  const sy = (v: number) => PAD.top + ih - (v / max) * ih;

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    for (const { p, x } of pts) {
      const v = val(p, s.key);
      if (v === null) {
        pen = false; // gap: missing data is not zero
        continue;
      }
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  });
  const lastIdx = (key: string) => {
    for (let i = pts.length - 1; i >= 0; i--) if (val(pts[i]!.p, key) !== null) return i;
    return -1;
  };
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const xTicks = 4;
  const withDate = to - from > 36 * 3600_000;

  const nearest = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = from + ((clientX - rect.left - PAD.left) / iw) * (to - from);
    let best = -1;
    let bd = Infinity;
    pts.forEach((q, i) => {
      const dd = Math.abs(q.x - x);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best === -1 ? null : best;
  };

  const h = hover !== null ? pts[hover] : undefined;
  const hx = h ? sx(h.x) : 0;

  return (
    <div className="card">
      <div className="chart-head">
        <h3>{title}</h3>
        {subtitle && <span className="sub">{subtitle}</span>}
      </div>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <span className="key" style={{ background: color(s.slot) }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div
        className="chart"
        ref={ref}
        tabIndex={0}
        role="img"
        aria-label={`${title}: gráfico de linha; use as setas para percorrer os pontos`}
        onPointerMove={(e) => pts.length && setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (!pts.length) return;
          if (e.key === 'ArrowRight') setHover((i) => Math.min(pts.length - 1, (i ?? -1) + 1));
          else if (e.key === 'ArrowLeft') setHover((i) => Math.max(0, (i ?? pts.length) - 1));
          else if (e.key === 'Escape') setHover(null);
        }}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className={i === 0 ? 'baseline' : 'gridline'} x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
              <text className="tick" x={PAD.left - 6} y={sy(t) + 3.5} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {Array.from({ length: xTicks + 1 }, (_, i) => from + ((to - from) * i) / xTicks).map((x, i) => (
            <text key={i} className="tick" x={sx(x)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks ? 'end' : 'middle'}>
              {time(new Date(x).toISOString(), withDate)}
            </text>
          ))}
          {pts.length === 0 && (
            <text className="empty" x={PAD.left + iw / 2} y={PAD.top + ih / 2} textAnchor="middle">
              Sem dados neste período
            </text>
          )}
          {series.length === 1 && paths[0] && (
            <path
              d={`${paths[0]}L${sx(pts[lastIdx(series[0]!.key)]?.x ?? from).toFixed(1)},${sy(0)}L${sx(pts.find((q) => val(q.p, series[0]!.key) !== null)?.x ?? from).toFixed(1)},${sy(0)}Z`}
              fill={color(series[0]!.slot)}
              opacity={0.1}
            />
          )}
          {series.map((s, i) => (
            <path key={s.key} d={paths[i]} fill="none" stroke={color(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const li = lastIdx(s.key);
            if (li < 0) return null;
            const q = pts[li]!;
            return <circle key={s.key} cx={sx(q.x)} cy={sy(val(q.p, s.key)!)} r={4} fill={color(s.slot)} stroke="var(--surface-1)" strokeWidth={2} />;
          })}
          {h && (
            <g>
              <line className="crosshair" x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + ih} />
              {series.map((s) => {
                const v = val(h.p, s.key);
                return v === null ? null : <circle key={s.key} cx={hx} cy={sy(v)} r={4} fill={color(s.slot)} stroke="var(--surface-1)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {h && (
          <div className="tooltip" style={{ left: Math.min(Math.max(0, hx + 10), width - 150), top: PAD.top }}>
            <div className="t">{time(h.p.t, true)}</div>
            {series.map((s) => {
              const v = val(h.p, s.key);
              return (
                <div className="row" key={s.key}>
                  <span className="key" style={{ background: color(s.slot) }} />
                  <strong>{v === null ? '—' : format(v)}</strong>
                  <span className="muted">{s.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <details className="table-view">
        <summary>Ver tabela</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                {series.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...pts].reverse().map(({ p }) => (
                <tr key={p.t}>
                  <td>{time(p.t, true)}</td>
                  {series.map((s) => {
                    const v = val(p, s.key);
                    return (
                      <td key={s.key} className="num">
                        {v === null ? '—' : format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
