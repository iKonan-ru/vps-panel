import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const MOBILE_ACTIONS_ID = 'mobile-actions';

/**
 * Кнопки страницы в правой части верхней плашки на мобиле (лупа, плюс). На широком экране
 * плашки нет, и портал ничего не рисует - там кнопки стоят в самой странице.
 */
export function MobileActions({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById(MOBILE_ACTIONS_ID));
  }, []);
  if (!el) return null;
  return createPortal(children, el);
}
