import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/** Открытые окна по порядку: Esc закрывает только верхнее (подтверждение поверх окна). */
const stack: symbol[] = [];

/** Простое модальное окно: затемнение, Esc закрывает, кнопка в углу. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  // колбэк в ref: новая функция при перерисовке не должна поднимать окно наверх стека
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-30 flex animate-fade-in items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh]"
      role="presentation"
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
        aria-label={title}
        className={cn(
          'relative z-10 w-full animate-pop-in rounded-xl border border-border bg-surface shadow-xl',
          wide ? 'max-w-[900px]' : 'max-w-[560px]',
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <div className="font-semibold">{title}</div>
          <div className="grow" />
          <Button size="icon" variant="ghost" aria-label="Закрыть" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex flex-col gap-4 p-5">{children}</div>
      </div>
    </div>
  );
}
