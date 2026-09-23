import type { ReactNode } from 'react';

export interface MeterProps {
  name: string;
  sub?: string;
  value: string;
  /** No reading available: value is shown muted and the bar is empty. */
  muted?: boolean;
  /** Percent of the track (0–100). */
  owner?: number;
  ghost?: number;
  /** Single-value gauge (temperature) instead of owner/ghost stack. */
  heat?: number;
  /** Gauge is near/over its limit: warning color. */
  hot?: boolean;
  /** Owner's limit on the same scale; null = no marker. */
  cap?: number | null;
  capNone?: boolean;
  over?: boolean;
  foot?: ReactNode;
  footRight?: ReactNode;
}

const clamp = (v: number | undefined) => Math.max(0, Math.min(100, v ?? 0));

/**
 * One resource. ghost's share is drawn first, from zero, so it compares directly
 * with the limit tick; the owner's use stacks after it.
 */
export function Meter(p: MeterProps) {
  const ghost = clamp(p.ghost);
  const owner = Math.min(clamp(p.owner), 100 - ghost);
  return (
    <div className={`meter${p.over ? ' over' : ''}`} data-testid={`meter-${p.name}`}>
      <div className="meter-head">
        <span className="meter-name">{p.name}</span>
        {p.sub && (
          <span className="meter-sub" title={p.sub}>
            {p.sub}
          </span>
        )}
        <span className={`meter-value num${p.muted ? ' muted' : ''}`}>{p.value}</span>
      </div>
      <div
        className="bar"
        role="img"
        aria-label={`${p.name}: ${p.value}${p.cap != null ? `, limite em ${Math.round(p.cap)}%` : ''}`}
      >
        {!p.muted && p.heat == null && ghost > 0 && (
          <span className="seg ghost" style={{ left: 0, width: `${ghost}%` }} />
        )}
        {!p.muted && p.heat == null && (
          <span className={`seg owner${ghost > 0 ? '' : ' first'}`} style={{ left: `${ghost}%`, width: `${owner}%` }} />
        )}
        {!p.muted && p.heat != null && (
          <span className={`seg gauge${p.hot ? ' hot' : ''}`} style={{ left: 0, width: `${clamp(p.heat)}%` }} />
        )}
        {p.cap != null && <span className={`cap${p.capNone ? ' none' : ''}`} style={{ left: `${clamp(p.cap)}%` }} />}
      </div>
      <div className="meter-foot">
        <span>{p.foot}</span>
        {p.footRight && <span className="right">{p.footRight}</span>}
      </div>
    </div>
  );
}
