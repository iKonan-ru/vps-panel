import { useQueryClient } from '@tanstack/react-query';
import type { Metrics, ServerSummary } from '@vps/protocol';
import { useEffect } from 'react';
import type { ServerDetail } from './servers';

export type LiveEvent = {
  type: string;
  serverId?: string;
  /** server.metrics: сами цифры - раз в 2 с, пока открыта вкладка */
  metrics?: Metrics;
  actionId?: string;
  channel?: string;
  chunk?: string;
  exitCode?: number;
  kind?: string;
  /** gclients.sync: началась (true) или закончилась синхронизация клиентов */
  syncing?: boolean;
};

type Listener = (ev: LiveEvent) => void;

/**
 * Одно websocket-соединение на вкладку браузера. Открывается при первом
 * подписчике и живёт до закрытия вкладки; при обрыве переподключается.
 * Без подписчиков соединение не закрывается: иначе при переходах между
 * страницами их накапливалось бы несколько, и каждая строка вывода
 * приходила бы по нескольку раз.
 */
const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Пауза перед переподключением: растёт до 30 с, после удачного подключения - снова 3 с. */
let retryMs = 3000;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/ui`);
  ws = sock;
  sock.onopen = () => {
    retryMs = 3000;
  };
  sock.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data as string) as LiveEvent;
      for (const l of listeners) l(ev);
    } catch {}
  };
  sock.onclose = (e) => {
    // Реагируем только на закрытие текущего соединения, а не старого.
    if (ws !== sock) return;
    ws = null;
    if (timer) clearTimeout(timer);
    // Без входа (4001) и без подписчиков - не переподключаемся: после входа подписка подключит
    // снова (иначе на странице входа сокет переподключался бы каждые 3 с без конца).
    if (e.code === 4001 || listeners.size === 0) return;
    timer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  connect();
  return () => {
    listeners.delete(l);
  };
}

/**
 * Обновление кэша по событиям панели; вызывается один раз в лейауте. Метрики (раз в 2 с, пока
 * открыта вкладка) приходят с цифрами - они кладутся в список и карточку сервера без запроса.
 * Снимки (раз в 5 минут) - точечно: список и карточка своего сервера, не чаще раза в 5 с. Связь,
 * изменения и действия - сразу.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const dirty = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      flush = null;
      void qc.invalidateQueries({ queryKey: ['servers'], exact: true });
      for (const id of dirty) void qc.invalidateQueries({ queryKey: ['servers', id], exact: true });
      dirty.clear();
    };
    const un = subscribe((ev) => {
      // переподключились: события за время обрыва потеряны - перечитать всё
      if (ev.type === 'hello') {
        void qc.invalidateQueries({ queryKey: ['servers'] });
        void qc.invalidateQueries({ queryKey: ['actions'] });
        void qc.invalidateQueries({ queryKey: ['gclients-syncing'] });
        return;
      }
      // синхронизация клиентов началась или закончилась: полоса сверху и списки клиентов
      if (ev.type === 'gclients.sync') {
        void qc.invalidateQueries({ queryKey: ['gclients-syncing'] });
        if (!ev.syncing) void qc.invalidateQueries({ queryKey: ['gclients'] });
        return;
      }
      if (ev.type === 'server.metrics' && ev.serverId && ev.metrics) {
        const { serverId, metrics } = ev;
        qc.setQueryData<ServerSummary[]>(['servers'], (list) =>
          list?.map((s) => (s.id === serverId ? { ...s, metrics } : s)),
        );
        qc.setQueryData<ServerDetail>(['servers', serverId], (d) =>
          d ? { ...d, metrics, metricsAt: new Date().toISOString() } : d,
        );
        return;
      }
      if (ev.type === 'server.metrics' || ev.type === 'server.inventory') {
        if (ev.serverId) dirty.add(ev.serverId);
        flush ??= setTimeout(refresh, 5000);
        return;
      }
      // вывод действия читает только его консоль (subscribe), карточке и списку он не нужен
      if (ev.type === 'action.stream') return;
      if (ev.type.startsWith('server.') || ev.type.startsWith('action.')) {
        // change без serverId (добавили или удалили сервер) - весь список
        if (ev.serverId) void qc.invalidateQueries({ queryKey: ['servers', ev.serverId] });
        void qc.invalidateQueries({ queryKey: ['servers'], exact: true });
      }
      if (ev.type === 'action.finished') void qc.invalidateQueries({ queryKey: ['actions'] });
    });
    return () => {
      un();
      if (flush) clearTimeout(flush);
    };
  }, [qc]);
}
