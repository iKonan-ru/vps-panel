import { cn } from '@/lib/cn';
import type { HTMLAttributes } from 'react';

export function Alert({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: 'bad' | 'ok' | 'info' }) {
  const { tone = 'info', ...r } = rest;
  const t = {
    bad: 'border-bad/40 text-bad',
    ok: 'border-ok/40 text-ok',
    info: 'border-border text-muted',
  }[tone];
  return (
    <div
      role="alert"
      className={cn('animate-fade-in rounded-lg border px-3 py-2 text-sm', t, className)}
      {...r}
    />
  );
}
