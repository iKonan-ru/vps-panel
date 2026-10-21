import { cn } from '@/lib/cn';
import { cap } from '@/lib/format';
import type { HTMLAttributes } from 'react';

export function Alert({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: 'bad' | 'ok' | 'info' }) {
  const { tone = 'info', children, ...r } = rest;
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
        'min-w-0 animate-reveal rounded-lg border px-3 py-2 text-sm [overflow-wrap:anywhere]',
        t,
        className,
      )}
      {...r}
    >
      {/* ошибки API - со строчной (их вставляют и после двоеточия); отдельно - с прописной */}
      {typeof children === 'string' ? cap(children) : children}
    </div>
  );
}
