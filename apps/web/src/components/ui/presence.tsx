import { usePresence } from '@/lib/use-presence';
import { type ReactNode, createContext, useContext, useRef } from 'react';

const Closing = createContext(false);

/** Внутри Presence, который уже закрывается: Dialog внутри играет закрытие. */
export function useClosing(): boolean {
  return useContext(Closing);
}

/**
 * Окно, которое монтируется только на время открытия (каждое открытие - с чистой формой):
 * `{x && <SomeDialog x={x} />}` -> `<Presence value={x}>{(x) => <SomeDialog x={x} />}</Presence>`.
 * После закрытия содержимое живёт ещё время анимации - с последним value, а Dialog внутри
 * получает "закрывается" и играет закрытие; следующее открытие монтирует его заново.
 */
export function Presence<T>({
  value,
  children,
}: {
  value: T | null | undefined | false;
  children: (value: T) => ReactNode;
}) {
  const open = value !== null && value !== undefined && value !== false;
  const last = useRef<{ value: T } | null>(null);
  if (open) last.current = { value: value as T };
  const { shown } = usePresence(open);
  if (!shown || !last.current) return null;
  return <Closing.Provider value={!open}>{children(last.current.value)}</Closing.Provider>;
}
