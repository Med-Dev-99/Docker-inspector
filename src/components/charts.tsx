// Lightweight SVG charts tuned for live metrics.
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { time as fmtTime } from '../lib/format';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

export interface Series { name: string; color: string; values: number[]; dashed?: boolean; fill?: boolean }

export function AreaChart({ times, series, height = 160, format, max, minMax = 0, window: maxWindow = 300_000, legend = true }: {
  times: number[]; series: Series[]; height?: number; format: (v: number) => string; max?: number; minMax?: number; window?: number; legend?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const padL = 0, padR = 52, padT = 8, padB = 18;
  const w = Math.max(0, width - padL - padR);
  const h = height - padT - padB;
  let win = maxWindow;
  const now = times.length ? times[times.length - 1] : Date.now();
  // Grow the visible window with the data (1 → 5 min) so a fresh launch isn't an empty chart.
  const span = times.length ? now - times[0] : 0;
  win = Math.min(win, Math.max(60_000, Math.ceil(span / 30_000) * 30_000));
  const t0 = now - win;

  let dataMax = 0;
  for (const s of series) for (const v of s.values) if (v > dataMax) dataMax = v;
  const yMax = max ?? niceMax(Math.max(minMax, dataMax * 1.1));
  const x = (t: number) => padL + ((t - t0) / win) * w;
  const y = (v: number) => padT + h - (Math.min(v, yMax) / yMax) * h;

  const start = times.findIndex((t) => t >= t0 - 2000);
  const idx = start < 0 ? [] : times.map((_, i) => i).slice(start);

  const paths = series.map((s) => {
    if (!idx.length) return { line: '', area: '' };
    let line = '';
    idx.forEach((i, k) => { line += `${k ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`; });
    const area = `${line}L${x(times[idx[idx.length - 1]]).toFixed(1)},${padT + h}L${x(times[idx[0]]).toFixed(1)},${padT + h}Z`;
    return { line, area };
  });

  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const timeTicks = [0, 1, 2, 3, 4, 5].map((k) => t0 + (win / 5) * k);

  const onMove = (e: React.MouseEvent) => {
    if (!idx.length) return;
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - padL) / w) * win;
    let best = idx[0];
    for (const i of idx) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    setHover(best);
  };

  const hv = hover !== null && hover < times.length ? hover : null;
  const tipLeft = hv !== null ? x(times[hv]) : 0;

  return (
    <div className="chart" ref={ref}>
      {legend && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name} className="legend-item">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.name}
              <b>{format(hv !== null ? s.values[hv] ?? 0 : s.values[s.values.length - 1] ?? 0)}</b>
            </span>
          ))}
        </div>
      )}
      {width > 0 && (
        <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="chart-svg">
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`g${uid}${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
            <clipPath id={`c${uid}`}><rect x={padL} y={0} width={w} height={height} /></clipPath>
          </defs>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + w} y1={y(v)} y2={y(v)} className={i === 0 ? 'grid base' : 'grid'} />
              <text x={padL + w + 8} y={y(v) + 4} className="axis">{format(v)}</text>
            </g>
          ))}
          {timeTicks.map((t, i) => (
            <text key={i} x={x(t)} y={height - 3} className="axis" textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}>
              {i === 5 ? 'now' : win <= 120_000 ? `-${Math.round((now - t) / 1000)}s` : `-${Math.round(((now - t) / 60000) * 10) / 10}m`}
            </text>
          ))}
          <g clipPath={`url(#c${uid})`}>
            {series.map((s, i) => s.fill !== false && <path key={'a' + i} d={paths[i].area} fill={`url(#g${uid}${i})`} />)}
            {series.map((s, i) => (
              <path key={'l' + i} d={paths[i].line} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={s.dashed ? '4 3' : undefined} />
            ))}
          </g>
          {hv !== null && (
            <g>
              <line x1={tipLeft} x2={tipLeft} y1={padT} y2={padT + h} className="crosshair" />
              {series.map((s, i) => <circle key={i} cx={tipLeft} cy={y(s.values[hv] ?? 0)} r={3.5} fill={s.color} className="hover-dot" />)}
            </g>
          )}
        </svg>
      )}
      {hv !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(tipLeft, 60), width - 120), top: 22 }}>
          <div className="chart-tip-time">{fmtTime(times[hv])}</div>
          {series.map((s) => (
            <div key={s.name} className="chart-tip-row"><span className="legend-swatch" style={{ background: s.color }} />{s.name}<b>{format(s.values[hv] ?? 0)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color, height = 28, max }: { values: number[]; color: string; height?: number; max?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, '');
  const vals = values.slice(-60);
  const m = max ?? Math.max(1e-9, ...vals) * 1.15;
  const step = vals.length > 1 ? width / (vals.length - 1) : width;
  let line = '';
  vals.forEach((v, i) => { line += `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 1 - (Math.min(v, m) / m) * (height - 3)).toFixed(1)}`; });
  return (
    <div className="spark" ref={ref} style={{ height }}>
      {width > 0 && vals.length > 1 && (
        <svg width={width} height={height}>
          <defs>
            <linearGradient id={`s${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${line}L${width},${height}L0,${height}Z`} fill={`url(#s${uid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

export function Ring({ value, size = 64, stroke = 7, color = 'var(--accent)', children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} className="ring-value" />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

export function Donut({ segments, size = 140, stroke = 18, children }: { segments: { value: number; color: string; label: string }[]; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} fill="none" />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const gap = segments.length > 1 && len > 3 ? 2 : 0;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} stroke={s.color} strokeWidth={stroke} fill="none"
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              <title>{s.label}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

export function StackedBar({ segments, height = 10 }: { segments: { value: number; color: string; label: string }[]; height?: number }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="stacked" style={{ height }}>
      {segments.filter((s) => s.value > 0).map((s, i) => (
        <div key={i} className="stacked-seg" style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={s.label} />
      ))}
    </div>
  );
}
