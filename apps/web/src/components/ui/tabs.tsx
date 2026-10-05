import { cn } from '@/lib/cn';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/**
 * Полоса вкладок с подчёркиванием; на узком экране прокручивается внутри себя. Подчёркивание
 * переезжает к выбранной вкладке плавно (первое появление - без анимации).
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: { id: T; title: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<{ left: number; width: number; animate: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: выбранная вкладка ищется в DOM - пересчёт при смене value и списка
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el) {
      setLine(null);
      return;
    }
    const place = () =>
      setLine((prev) =>
        prev && prev.left === el.offsetLeft && prev.width === el.offsetWidth
          ? prev
          : { left: el.offsetLeft, width: el.offsetWidth, animate: prev !== null },
      );
    place();
    // ширина вкладки меняется после загрузки шрифта и при смене подписи
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, items]);
  return (
    <div
      ref={list}
      role="tablist"
      className={cn(
        'relative -mt-1 flex min-w-0 gap-4 overflow-x-auto border-b border-border [scrollbar-width:none] sm:gap-6 [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'whitespace-nowrap px-0.5 pb-3 text-sm transition-colors',
            value === t.id ? 'text-text' : 'text-muted hover:text-text',
          )}
        >
          {t.title}
        </button>
      ))}
      {line && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-accent',
            line.animate &&
              'transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          )}
          style={{ left: line.left, width: line.width }}
        />
      )}
    </div>
  );
}
