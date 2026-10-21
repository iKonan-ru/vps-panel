import { cn } from '@/lib/cn';
import type { InputHTMLAttributes, ReactNode } from 'react';

/** Чекбокс с подписью; hint - вторая строка серым, квадратик - у первой строки. */
export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label
      className={cn(
        'flex gap-2.5 text-sm',
        hint ? 'items-start' : 'items-center',
        rest.disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        className={cn(
          'check-anim size-4 shrink-0 cursor-pointer appearance-none rounded border border-border bg-bg accent-accent',
          'checked:border-accent checked:bg-accent checked:bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20fill%3D%27none%27%20stroke%3D%27white%27%20stroke-width%3D%272.2%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20d%3D%27M3.5%208.5l3%203%206-7%27/%3E%3C/svg%3E")] checked:bg-center checked:bg-no-repeat',
          'focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
          hint && 'mt-0.5',
        )}
        {...rest}
      />
      <span className="min-w-0">
        <span>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
