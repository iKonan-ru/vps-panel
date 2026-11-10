import { type Align, type Block, type Inline, parseMarkdown } from '@/lib/markdown';
import { isSafeHref } from '@/lib/safe-url';
import { type ReactNode, useMemo } from 'react';

const ALIGN: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function Inlines({ c }: { c: Inline[] }): ReactNode {
  return c.map((x, i) => {
    const key = `${i}`;
    if (typeof x === 'string') return x;
    switch (x.t) {
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em] text-text"
          >
            {x.text}
          </code>
        );
      case 'b':
        return (
          <strong key={key} className="font-semibold text-text">
            <Inlines c={x.c} />
          </strong>
        );
      case 'i':
        return (
          <em key={key}>
            <Inlines c={x.c} />
          </em>
        );
      case 's':
        return (
          <del key={key}>
            <Inlines c={x.c} />
          </del>
        );
      case 'br':
        return <br key={key} />;
      case 'a':
        return isSafeHref(x.href) ? (
          <a
            key={key}
            href={x.href}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            <Inlines c={x.c} />
          </a>
        ) : (
          <Inlines key={key} c={x.c} />
        );
    }
  });
}

const HEADINGS = [
  'text-base',
  'text-[15px]',
  'text-sm',
  'text-[13px]',
  'text-xs',
  'text-xs text-muted',
];

function Blocks({ blocks }: { blocks: Block[] }): ReactNode {
  return blocks.map((b, i) => {
    const key = `${i}`;
    switch (b.t) {
      case 'h': {
        const Tag = `h${b.level}` as 'h1';
        return (
          <Tag
            key={key}
            className={`font-semibold text-text ${HEADINGS[b.level - 1]} ${b.level <= 2 ? 'border-b border-border pb-1' : ''}`}
          >
            <Inlines c={b.c} />
          </Tag>
        );
      }
      case 'p':
        return (
          <p key={key}>
            <Inlines c={b.c} />
          </p>
        );
      case 'hr':
        return <hr key={key} className="border-0 border-t border-border" />;
      case 'quote':
        return (
          <blockquote key={key} className="flex flex-col gap-2 border-l-2 border-border pl-3">
            <Blocks blocks={b.blocks} />
          </blockquote>
        );
      case 'code':
        return (
          <pre
            key={key}
            className="overflow-x-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-text"
          >
            <code>{b.text}</code>
          </pre>
        );
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={key}
            start={b.ordered ? b.start : undefined}
            className={`pl-5 [&>li+li]:mt-1 ${b.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {b.items.map((it, k) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: порядок пунктов не меняется
                key={k}
                // не flex: у flex-элемента пропадает маркер списка
                className={`[&>*+*]:mt-1 ${it.task !== null ? 'list-none' : ''}`}
              >
                {it.task !== null && (
                  <input
                    type="checkbox"
                    checked={it.task}
                    disabled
                    readOnly
                    aria-label={it.task ? 'Выполнено' : 'Не выполнено'}
                    className="-ml-5 mr-1.5 inline size-3 align-middle"
                  />
                )}
                <Blocks blocks={it.blocks} />
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  {b.head.map((h, k) => (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: колонки фиксированы
                      key={k}
                      className={`border border-border bg-surface-2 px-2.5 py-1 font-semibold text-text ${cellAlign(b.align[k])}`}
                    >
                      <Inlines c={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: строки не меняются
                  <tr key={k}>
                    {r.map((cell, m) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: колонки фиксированы
                        key={m}
                        className={`border border-border px-2.5 py-1 ${cellAlign(b.align[m])}`}
                      >
                        <Inlines c={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

const cellAlign = (a: Align | undefined) => (a ? (ALIGN[a] ?? '') : '');

/**
 * Markdown как на GitHub: описания релизов панели. Разбор - lib/markdown.ts, HTML из текста не
 * выполняется, ссылки только из списка безопасных схем.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="flex flex-col gap-2 break-words text-xs text-muted">
      <Blocks blocks={blocks} />
    </div>
  );
}
