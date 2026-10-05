import { Card } from '@/components/ui/card';
import { Meter } from '@/components/ui/meter';
import { Num } from '@/components/ui/num';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

/**
 * Плашка показателя - одна на всю панель (Обзор, вкладки сервисов, firewall, Настройки):
 * подпись (справа - action: кнопка или переключатель), крупное значение - число или состояние
 * словом ("Работает"; tone красит его), подстрочник, children - кнопки под ним, и тонкая шкала
 * заполнения во всю ширину внизу (зелёная до 70%, жёлтая до 90%, красная выше; Meter - плавно).
 * Без pct шкалы нет. Числа в value плавные, если переданы через Num.
 */
export function MetricCard({
  label,
  value,
  unit,
  note,
  pct,
  hidePct,
  action,
  tone,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  note?: ReactNode;
  /** Заполнение 0..100; null - данных нет (шкала пустая). */
  pct?: number | null;
  /** Не повторять процент в заголовке, когда он и есть крупное значение (CPU). */
  hidePct?: boolean;
  action?: ReactNode;
  /** Цвет крупного значения: состояние словом (работает / остановлен / отклонение). */
  tone?: 'ok' | 'warn' | 'bad' | 'muted' | undefined;
  children?: ReactNode;
}) {
  const p = pct == null ? null : Math.max(0, Math.min(100, pct));
  const bar = p == null ? 'bg-border' : p >= 90 ? 'bg-bad' : p >= 70 ? 'bg-warn' : 'bg-ok';
  return (
    <Card className="flex min-w-0 flex-col p-3 md:p-4">
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted">
        <span className="min-w-0 truncate">{label}</span>
        {p != null && !hidePct && (
          <span className={cn('font-mono', p >= 90 ? 'text-bad' : p >= 70 ? 'text-warn' : '')}>
            <Num value={p} format={(v) => `${Math.round(v)}%`} />
          </span>
        )}
        <span className="grow" />
        {action}
      </div>
      <div
        className={cn(
          'my-1 truncate text-xl font-semibold md:text-2xl',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
          tone === 'muted' && 'text-muted',
        )}
      >
        {value}
        {unit && <span className="text-sm text-muted"> {unit}</span>}
      </div>
      {note && <div className="truncate text-xs text-muted">{note}</div>}
      {children}
      {pct !== undefined && (
        <Meter pct={p ?? 0} className="mt-2.5 h-1 w-full bg-surface-2" fill={bar} />
      )}
    </Card>
  );
}
