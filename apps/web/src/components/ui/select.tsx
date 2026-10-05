import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

/**
 * Нативный select со своей стрелкой. Сам список вариантов рисует браузер,
 * его вид и курсор задать нельзя - для этого нужен собственный выпадающий список.
 */
export function Select({
  className,
  size = 'md',
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: 'md' | 'sm' }) {
  return (
    <div className={cn('relative', className)}>
      <select
        className={cn(
          'w-full appearance-none rounded-lg border border-border bg-bg text-text',
          'focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-7 pr-7 pl-2.5 text-xs' : 'h-9 pr-9 pl-3 text-sm',
        )}
        {...rest}
      />
      <ChevronDown
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted',
          size === 'sm' ? 'right-2 size-3.5' : 'right-3 size-4',
        )}
        aria-hidden="true"
      />
    </div>
  );
}
