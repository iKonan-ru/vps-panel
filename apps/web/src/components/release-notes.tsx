import { isSafeHref } from '@/lib/safe-url';
import type { ReactNode } from 'react';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

/** Разметка описаний релизов (CHANGELOG): `код`, **жирный**, [текст](ссылка); остальное - текстом. */
export function ReleaseNotes({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text
    .trim()
    .split(INLINE)
    .forEach((p, i) => {
      const key = `${i}`;
      if (p.length > 2 && p.startsWith('`') && p.endsWith('`'))
        parts.push(
          <code key={key} className="rounded bg-surface-2 px-1 font-mono text-[11px] text-text">
            {p.slice(1, -1)}
          </code>,
        );
      else if (p.length > 4 && p.startsWith('**') && p.endsWith('**'))
        parts.push(
          <strong key={key} className="font-semibold text-text">
            {p.slice(2, -2)}
          </strong>,
        );
      else {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (m && isSafeHref(m[2]))
          parts.push(
            <a key={key} href={m[2]} target="_blank" rel="noreferrer" className="text-accent">
              {m[1]}
            </a>,
          );
        else parts.push(p);
      }
    });
  return <div className="whitespace-pre-wrap text-xs text-muted">{parts}</div>;
}
