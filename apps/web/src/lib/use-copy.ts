import { useCallback, useEffect, useRef, useState } from 'react';

/** Копирование в буфер обмена с отметкой "скопировано" на 1.5 с. */
export function useCopy() {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    setError(null);
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        setCopied(false);
        setError('Не удалось скопировать');
      });
  }, []);
  /** Сбросить отметку (сменилось, что копируем). */
  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setCopied(false);
  }, []);
  return { copied, copy, reset, error };
}
