import { useId } from 'react';

/**
 * Логотип панели; compact - только знак, без подписи. Знак - встроенный SVG в цветах темы (тот же
 * рисунок, что public/icon.svg): в светлой теме плитка светлая.
 */
export function Logo({ size = 28, compact = false }: { size?: number; compact?: boolean }) {
  // useId даёт двоеточия, в url(#...) они не годятся
  const id = `logo${useId().replace(/[^\w-]/g, '')}`;
  return (
    <div className="flex items-center gap-2.5">
      <svg
        viewBox="0 0 512 512"
        width={size}
        height={size}
        aria-hidden="true"
        className="shrink-0"
        style={{ width: size, height: size }}
      >
        <defs>
          <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--logo-bg-1)' }} />
            <stop offset="1" style={{ stopColor: 'var(--logo-bg-2)' }} />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="112" fill={`url(#${id}bg)`} />
        {[150, 274].map((y) => (
          <g key={y}>
            <rect
              x="112"
              y={y}
              width="288"
              height="88"
              rx="22"
              fill="none"
              strokeWidth="30"
              style={{ stroke: 'var(--logo-line)' }}
            />
            <circle cx="336" cy={y + 44} r="20" style={{ fill: 'var(--logo-dot)' }} />
            <rect
              x="160"
              y={y + 32}
              width="56"
              height="24"
              rx="12"
              style={{ fill: 'var(--logo-line)' }}
            />
          </g>
        ))}
      </svg>
      {!compact && <div className="logo-text font-semibold">VPS Panel</div>}
    </div>
  );
}
