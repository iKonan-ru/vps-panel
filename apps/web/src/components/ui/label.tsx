import { cn } from '@/lib/cn';
import type { LabelHTMLAttributes } from 'react';

/** Подпись поля. Ставь htmlFor, чтобы связать с input (правило a11y отключено тут осознанно). */
export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: связь задаётся через htmlFor вызывающим кодом
  return <label className={cn('text-xs tracking-wide text-muted', className)} {...rest} />;
}
