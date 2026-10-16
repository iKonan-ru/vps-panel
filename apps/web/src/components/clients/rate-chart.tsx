import { HISTORY_MS, type RatePoint, rate } from '@/components/clients/live-stats';
import { useEffect, useRef, useState } from 'react';

// пара цветов --series-1/2 различима при нарушениях цветовосприятия
const SERIES = [
  { key: 'out', label: 'к клиенту', color: 'var(--series-1)' },
  { key: 'in', label: 'от клиента', color: 'var(--series-2)' },
] as const;

const PAD_TOP = 6;
const PAD_BOTTOM = 18;

/** Верх шкалы: круглое число в КБ/МБ/ГБ (как их пишет bytes), с запасом над максимумом. */
function niceMax(v: number): number {
  const base = Math.max(v, 1024) * 1.1;
  const unit = 1024 ** Math.floor(Math.log(base) / Math.log(1024));
  for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (m * unit >= base) return m * unit;
  return 1024 * unit;
}

/** Окно по времени: с первой точки, но не меньше минуты и не больше HISTORY_MS. */
const MIN_SPAN_MS = 60_000;

function agoShort(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'сейчас';
  if (s < 60) return `${s}\u00a0с назад`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}\u00a0мин ${s % 60}\u00a0с назад` : `${m}\u00a0мин назад`;
}

/** График скорости к клиенту и от клиента; неизвестная скорость - разрыв линии. */
export function RateChart({ points, height = 140 }: { points: RatePoint[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const last = points.at(-1);
  const enough = points.filter((p) => p.out !== null || p.in !== null).length >= 2;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const tEnd = last?.t ?? 0;
  const span = Math.min(HISTORY_MS, Math.max(MIN_SPAN_MS, tEnd - (points[0]?.t ?? tEnd)));
  const tStart = tEnd - span;
  const max = niceMax(Math.max(0, ...points.flatMap((p) => [p.out ?? 0, p.in ?? 0])));
  const x = (t: number) => ((t - tStart) / span) * width;
  const y = (v: number) => PAD_TOP + plotH - (v / max) * plotH;

  const path = (key: 'out' | 'in') => {
    let d = '';
    let open = false;
    for (const p of points) {
      const v = p[key];
      if (v === null) {
        open = false;
        continue;
      }
      d += `${open ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = tStart + ((e.clientX - r.left) / r.width) * span;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs((points[i] as RatePoint).t - t) < Math.abs((points[best] as RatePoint).t - t))
        best = i;
    }
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={box} className="relative min-w-0" style={{ height }}>
        {!enough && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            график появится через несколько секунд
          </div>
        )}
        {width > 0 && enough && (
          <>
            <svg
              width={width}
              height={height}
              className="block touch-none"
              role="img"
              aria-label="Скорость к клиенту и от клиента за последние минуты"
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {[0, 0.5, 1].map((k) => (
                <line
                  key={k}
                  x1={0}
                  x2={width}
                  y1={y(max * k)}
                  y2={y(max * k)}
                  stroke="var(--border)"
                  strokeWidth={1}
                  strokeDasharray={k === 0 ? undefined : '2 3'}
                />
              ))}
              <text x={2} y={y(max) + 11} fontSize={11} fill="var(--muted)">
                {rate(max)}
              </text>
              <text x={2} y={height - 4} fontSize={11} fill="var(--muted)">
                {agoShort(span)}
              </text>
              <text x={width - 2} y={height - 4} fontSize={11} fill="var(--muted)" textAnchor="end">
                сейчас
              </text>
              {SERIES.map((s) => (
                <path
                  key={s.key}
                  d={path(s.key)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {hp && (
                <g>
                  <line
                    x1={x(hp.t)}
                    x2={x(hp.t)}
                    y1={PAD_TOP}
                    y2={PAD_TOP + plotH}
                    stroke="var(--muted)"
                    strokeWidth={1}
                  />
                  {SERIES.map((s) =>
                    hp[s.key] === null ? null : (
                      <circle
                        key={s.key}
                        cx={x(hp.t)}
                        cy={y(hp[s.key] as number)}
                        r={4}
                        fill={s.color}
                        stroke="var(--surface)"
                        strokeWidth={2}
                      />
                    ),
                  )}
                </g>
              )}
            </svg>
            {hp && (
              <div
                className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg"
                style={x(hp.t) > width / 2 ? { right: width - x(hp.t) + 8 } : { left: x(hp.t) + 8 }}
              >
                <div className="text-muted">{agoShort(tEnd - hp.t)}</div>
                {SERIES.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                    <span className="font-semibold tabular-nums">
                      {hp[s.key] === null ? 'нет данных' : rate(hp[s.key] as number)}
                    </span>
                    <span className="text-muted">{s.label}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
