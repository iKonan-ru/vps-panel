import { cn } from '@/lib/cn';

/**
 * Шкала заполнения: дорожка (className - размер и фон) и заливка (fill - цвет). Заливка при
 * появлении растёт от нуля, новое значение и цвет - плавно (.meter-fill в index.css).
 */
export function Meter({
  pct,
  className,
  fill,
}: {
  pct: number;
  className?: string;
  fill?: string;
}) {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className={cn('overflow-hidden rounded-full', className)}>
      <div className={cn('meter-fill h-full rounded-full', fill)} style={{ width: `${p}%` }} />
    </div>
  );
}
