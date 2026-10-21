import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/use-presence';
import { Info } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Пояснение за иконкой - только "что это и как работает", не предупреждения и не ошибки. */
export function InfoTip({
  children,
  label = 'Пояснение',
}: { children: ReactNode; label?: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // pinned - открыто нажатием, hover - наведением мыши (на кнопку или на само пояснение)
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const leave = useRef<number | undefined>(undefined);
  const shown = pinned || hover;
  // гаснет плавно: пояснение ещё видно, пока идёт анимация закрытия
  const presence = usePresence(shown);

  const onEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(leave.current);
    setHover(true);
  };
  // с кнопки на пояснение мышь идёт через зазор: закрываем с задержкой
  const onLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    leave.current = window.setTimeout(() => setHover(false), 150);
  };

  useLayoutEffect(() => {
    if (!shown || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(300, vw - 16);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), vw - width - 8);
    const h = pop.current?.offsetHeight ?? 0;
    // снизу не помещается - над иконкой
    const below = r.bottom + 6;
    const top = h && below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left, width });
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) {
        setPinned(false);
        setHover(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // подсказка внутри окна: Esc закрывает только её (окна слушают window, после document)
        e.stopPropagation();
        setPinned(false);
        setHover(false);
      }
    };
    // прокрутка сдвигает иконку - пояснение закрываем, а не оставляем висеть отдельно
    const scroll = () => {
      setPinned(false);
      setHover(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [shown]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={shown}
        aria-describedby={shown ? id : undefined}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted transition-[color,scale] hover:scale-110 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPinned(!pinned);
        }}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
      >
        <Info className="size-3.5" />
      </button>
      {presence.shown &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="tooltip"
            onPointerEnter={onEnter}
            onPointerLeave={onLeave}
            style={
              pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }
            }
            inert={presence.closing}
            className={cn(
              'fixed z-40 rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed font-normal text-text shadow-xl',
              presence.closing ? 'pointer-events-none animate-fade-out' : 'animate-pop-in',
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
