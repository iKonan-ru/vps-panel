import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { MoreHorizontal } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Пункт меню: действие (onSelect) или ссылка наружу (href, в новой вкладке). */
export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  /** Почему недоступно или что сделает - подсказка пункта. */
  title?: string | undefined;
  danger?: boolean;
  /** Черта перед пунктом: следующая группа действий. */
  separator?: boolean;
}

const WIDTH = 248;

/** Меню "Ещё": список в портале (карточка его не обрезает), под кнопкой или над ней. */
export function Menu({
  items,
  label = 'Ещё действия',
  size = 'sm',
  variant = 'default',
  trigger,
  className,
}: {
  items: MenuItem[];
  label?: string;
  size?: 'sm' | 'md';
  /** ghost - в верхней плашке на мобиле, как её другие кнопки. */
  variant?: 'default' | 'ghost';
  /** Своя подпись кнопки (по умолчанию - только значок). */
  trigger?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = (focus = false) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = list.current?.offsetHeight ?? items.length * 40 + 8;
    const up = r.bottom + 6 + h > window.innerHeight - 8 && r.top - 6 - h > 8;
    const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
    setPos({ top: up ? r.top - 6 - h : r.bottom + 6, left, up });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function onKey(e: React.KeyboardEvent) {
    const all = [
      ...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      all[(n + all.length) % all.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') close();
  }

  function pick(it: MenuItem) {
    if (it.disabled) return;
    close(true);
    if (it.href) window.open(it.href, '_blank', 'noopener,noreferrer');
    else it.onSelect?.();
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={trigger ? undefined : label}
        title={trigger ? undefined : label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={buttonClass({
          variant,
          size: trigger ? size : size === 'sm' ? 'icon-sm' : 'icon',
          className: cn(
            !trigger && size === 'sm' && 'h-7.5 w-7.5',
            open && 'bg-border/60',
            className,
          ),
        })}
      >
        {trigger ?? <MoreHorizontal className="size-4" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKey}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: WIDTH }}
            className={cn(
              'glass-strong fixed z-50 flex animate-pop-in flex-col rounded-xl border p-1 shadow-xl',
              !pos && 'invisible',
            )}
          >
            {items.map((it) => (
              <div key={it.key} className="contents">
                {it.separator && <hr className="my-1 border-0 border-t border-border" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => pick(it)}
                  className={cn(
                    'flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none',
                    'hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
                    it.danger ? 'text-bad' : 'text-text',
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-muted [&>svg]:size-4">
                    {it.icon}
                  </span>
                  <span className="min-w-0">{it.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
