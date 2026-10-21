import { useEffect, useState } from 'react';

/** Длительность закрытия - как у animate-pop-out и animate-fade-out в index.css. */
export const EXIT_MS = 140;

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Закрытие с анимацией: после open=false элемент остаётся на экране ещё EXIT_MS (closing - пора
 * играть анимацию закрытия), потом убирается. При "уменьшить движение" - сразу. Пока closing,
 * элемент не должен принимать клики и клавиши: он уже закрыт.
 */
export function usePresence(open: boolean, ms = EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { shown: open || mounted, closing: !open && mounted };
}
