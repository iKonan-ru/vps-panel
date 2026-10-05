import { useCallback, useEffect, useRef, useState } from 'react';

/** Копирование в буфер обмена с отметкой "скопировано" на 1.5 с. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  /** Сбросить отметку (сменилось, что копируем). */
  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setCopied(false);
  }, []);
  return { copied, copy, reset };
}
