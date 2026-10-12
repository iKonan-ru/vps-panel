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
      // [overflow-wrap:anywhere]: ошибки бывают длинными словами без пробелов (пути, ответы
      // OpenSSL) - иначе строка вылезает за рамку и страница едет вбок
      className={cn(
        'animate-fade-in min-w-0 rounded-lg border px-3 py-2 text-sm [overflow-wrap:anywhere]',
        t,
        className,
      )}
      {...r}
    />
  );
}
