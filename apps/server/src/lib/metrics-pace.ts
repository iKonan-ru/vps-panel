import type { AgentRegistry } from '../agents/registry.js';
import type { UiHub } from './ui-hub.js';

/** Частота метрик, пока открыта вкладка панели, и когда никто не смотрит (секунды). */
export const FAST_METRICS_SEC = 2;
const SLOW_METRICS_SEC = 30;
/** Закрыли последнюю вкладку - замедлять не сразу: перезагрузка страницы не дёргает агентов. */
export const SLOW_AFTER_MS = 60_000;

/**
 * Частота метрик агентов: раз в 2 с, пока на связи хотя бы одна вкладка панели (/ws/ui), иначе
 * раз в 30 с. Агент после обрыва связи сам возвращается на 30 с, поэтому подключившемуся агенту
 * частота сообщается, только если нужна быстрая. Агенты без операции metrics.interval
 * пропускаются - у них 30 с. Возвращает остановку.
 */
export function startMetricsPace(
  registry: AgentRegistry,
  hub: UiHub,
  log: { warn: (o: unknown, m?: string) => void },
): () => void {
  let fast = false;
  let slowTimer: NodeJS.Timeout | null = null;
  const send = (serverId: string) => {
    if (!registry.isOnline(serverId) || !registry.supports(serverId, 'metrics.interval')) return;
    const sec = fast ? FAST_METRICS_SEC : SLOW_METRICS_SEC;
    registry
      .request(serverId, 'metrics.interval', { sec }, { timeoutMs: 10_000 })
      .catch((e: Error) => log.warn({ serverId, err: e.message }, 'metrics.interval'));
  };
  const apply = (next: boolean) => {
    if (next === fast) return;
    fast = next;
    for (const id of registry.onlineIds()) send(id);
  };
  hub.onCount((count) => {
    if (count > 0) {
      if (slowTimer) clearTimeout(slowTimer);
      slowTimer = null;
      apply(true);
    } else if (fast && !slowTimer) {
      slowTimer = setTimeout(() => {
        slowTimer = null;
        apply(false);
      }, SLOW_AFTER_MS);
      slowTimer.unref();
    }
  });
  // агент подключился: быстрая частота, если нужна (чуть позже - сначала уходит welcome)
  registry.on('online', (serverId) => {
    if (fast) setTimeout(() => send(serverId), 1000).unref();
  });
  return () => {
    if (slowTimer) clearTimeout(slowTimer);
  };
}
