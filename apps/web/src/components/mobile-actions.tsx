import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const MOBILE_ACTIONS_ID = 'mobile-actions';

/** Кнопки страницы в верхней плашке на узком экране; на широком портал ничего не рисует. */
export function MobileActions({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById(MOBILE_ACTIONS_ID));
  }, []);
  if (!el) return null;
  return createPortal(children, el);
}
