import { cn } from '@/lib/cn';
import type { LabelHTMLAttributes } from 'react';

/** Подпись поля; связь с input - через htmlFor. */
export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: связь задаётся через htmlFor вызывающим кодом
  return <label className={cn('text-xs tracking-wide text-muted', className)} {...rest} />;
}
