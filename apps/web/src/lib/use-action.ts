import { useCallback, useRef, useState } from 'react';

/**
 * Действие по кнопке: пока идёт запрос - busy, повторное нажатие (двойной тап) игнорируется;
 * ошибка - текстом в error. run возвращает true при успехе: окно закрывается только тогда.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // состояние обновится только к следующему рендеру, а второй тап может прийти раньше
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
