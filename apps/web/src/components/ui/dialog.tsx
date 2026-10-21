import { Button } from '@/components/ui/button';
import { useClosing } from '@/components/ui/presence';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/use-presence';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/** Открытые окна по порядку: Esc закрывает только верхнее (подтверждение поверх окна). */
const stack: symbol[] = [];

/**
 * Модальное окно; Esc и клик по затемнению закрывают. Закрывается с анимацией: пока она идёт,
 * окно показывает последние заголовок и содержимое (родитель обычно уже стёр данные окна) и не
 * принимает ни кликов, ни фокуса.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  // окно внутри закрывающегося Presence (смонтировано только на время открытия) - уже закрыто
  const closingParent = useClosing();
  const isOpen = open && !closingParent;
  // колбэк в ref: новая функция при перерисовке не должна поднимать окно наверх стека
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const me = Symbol();
    stack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === me) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(me), 1);
    };
  }, [isOpen]);
  const { shown, closing } = usePresence(isOpen);
  const last = useRef({ title, children });
  if (isOpen) last.current = { title, children };
  if (!shown) return null;
  const view = last.current;
  return (
    <div
      className={cn(
        'fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/45 p-4 pt-[8vh] backdrop-blur-[3px]',
        closing ? 'pointer-events-none animate-fade-out' : 'animate-fade-in',
      )}
      role="presentation"
      inert={closing}
    >
      <button
        type="button"
        className="fixed inset-0 cursor-default"
        aria-label="Закрыть"
        onClick={onClose}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: нативный dialog не даёт управлять затемнением и стилями единообразно */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={view.title}
        className={cn(
          'glass-strong relative z-10 w-full rounded-xl border shadow-2xl',
          closing ? 'animate-pop-out' : 'animate-pop-in',
          wide ? 'max-w-[900px]' : 'max-w-[560px]',
        )}
      >
        <div className="flex items-center gap-3 border-b border-[var(--glass-border)] px-5 py-3.5">
          <div className="font-semibold">{view.title}</div>
          <div className="grow" />
          <Button size="icon" variant="ghost" aria-label="Закрыть" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex flex-col gap-4 p-5">{view.children}</div>
      </div>
    </div>
  );
}
