import { cn } from '@/lib/cn';
import { type ReactNode, useEffect } from 'react';

/** Панель снизу над полосой вкладок на узком экране; полоса остаётся поверх затемнения. */
export function BottomSheet({
  open,
  onClose,
  label,
  children,
}: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Закрыть"
        className={cn(
          'fixed inset-0 z-10 cursor-default bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: как и Dialog, нативный dialog не даёт анимировать выезд */}
      <div
        role="dialog"
        aria-label={label}
        inert={!open}
        className={cn(
          'fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-10 rounded-t-2xl border-t glass-strong p-4 shadow-xl transition-transform duration-200 md:hidden',
          // закрытая панель уезжает вниз за полосу вкладок и край экрана
          open ? 'translate-y-0' : 'translate-y-[calc(100%+56px+env(safe-area-inset-bottom))]',
        )}
      >
        {children}
      </div>
    </>
  );
}
