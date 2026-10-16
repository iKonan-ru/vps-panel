import { Meter } from '@/components/ui/meter';
import { Num } from '@/components/ui/num';
import { cn } from '@/lib/cn';

/** Полоска заполнения с процентом: зелёная до warn, жёлтая от него. */
export function Bar({
  pct,
  warn = 80,
  className,
}: { pct: number; warn?: number; className?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Meter pct={p} className="h-1.5 w-[52px] bg-border" fill={p >= warn ? 'bg-warn' : 'bg-ok'} />
      {/* место под "100%": колонка не меняет ширину, когда значение становится трёхзначным */}
      <span className="inline-block min-w-[4ch] text-right font-mono text-[11px] text-muted">
        <Num value={p} format={(v) => `${Math.round(v)}%`} />
      </span>
    </div>
  );
}
