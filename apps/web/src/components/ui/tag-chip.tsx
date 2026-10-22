import { cn } from '@/lib/cn';
import { TAG_TONE } from '@/lib/tags';
import type { TagColor } from '@vps/protocol';
import { X } from 'lucide-react';

/**
 * Плашка тега: углы меньше, чем у плашек состояния (Chip), - чтобы не путать с ними. onClick -
 * плашка-кнопка (фильтр по тегу), active - выбранный фильтр; onRemove - крестик снять тег.
 */
export function TagChip({
  name,
  color,
  onClick,
  onRemove,
  active,
  disabled,
  className,
}: {
  name: string;
  color: TagColor;
  onClick?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const cls = cn(
    'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium leading-[18px] shadow-[inset_0_1px_0_var(--gloss-hi)]',
    TAG_TONE[color],
    active && 'ring-1 ring-current',
    className,
  );
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        className={cn(cls, 'transition-opacity duration-150 hover:opacity-75')}
      >
        <span className="min-w-0 truncate">{name}</span>
      </button>
    );
  return (
    <span className={cn(cls, onRemove && 'pr-1')}>
      <span className="min-w-0 truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Снять тег ${name}`}
          className="flex size-4 shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
