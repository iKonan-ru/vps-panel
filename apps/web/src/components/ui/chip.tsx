import { cn } from '@/lib/cn';
import type { HTMLAttributes } from 'react';

/** update - доступное обновление: свой цвет, чтобы не путать с плашками сервисов (accent). */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent' | 'update';

const tones: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  muted: 'bg-muted/15 text-muted',
  accent: 'bg-accent/15 text-accent',
  update: 'bg-update/15 text-update',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  dot?: boolean;
  /** Точка пульсирует: идёт процесс (перезагрузка, сверка). */
  pulse?: boolean;
}

/** Плашка состояния: всегда одна строка, точка не сжимается. */
export function Chip({ className, tone = 'muted', dot, pulse, children, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium leading-[18px] transition-colors duration-300',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          className={cn('size-2 shrink-0 rounded-full bg-current', pulse && 'animate-pulse')}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
