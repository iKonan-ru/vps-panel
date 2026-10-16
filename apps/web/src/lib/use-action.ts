import { useCallback, useRef, useState } from 'react';

/**
 * Действие по кнопке: busy на время запроса, повторное нажатие игнорируется, ошибка - в error.
 * run возвращает true при успехе.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ref, а не busy: состояние обновится к следующему рендеру, а второй тап может прийти раньше
  const running = useRef(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
