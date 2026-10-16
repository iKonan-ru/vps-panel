import { useQueryClient } from '@tanstack/react-query';
import type { Metrics, ServerDetail, ServerSummary } from '@vps/protocol';
import { useEffect } from 'react';
import { SERVICE_UPDATE_ACTIONS, checkUpdates } from './service-update';

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

/** Данные вкладок сервисов: их меняют команды, настройка сервера и синхронизация клиентов. */
const SERVICE_KEYS = [
  'xui',
  'xui-api',
  'xui-inbounds',
  'xui-clients',
  'mtproxyl',
  'awg',
  'wdtt',
  'openflux',
];

/**
 * Что перечитать после действия этого вида: ключи вида [имя, serverId] (и всё под ними) и
 * общие ключи без сервера. Карточка и список серверов перечитываются после любого действия.
 */
function staleAfter(kind: string): { server: string[]; global?: string[] } {
  const domain = /^[^:.]+/.exec(kind)?.[0] ?? kind;
  switch (domain) {
    case 'xui':
      return {
        server: ['xui', 'xui-api', 'xui-inbounds', 'xui-clients', 'xray-inbounds', 'access'],
      };
    case 'mtproxyl':
      return { server: ['mtproxyl', 'mtproxyl-engine'] };
    case 'awg':
      return { server: ['awg', 'awg-config'] };
    case 'wdtt':
      return { server: ['wdtt'] };
    case 'openflux':
      return { server: ['openflux'] };
    case 'firewall':
    case 'portsync':
      return { server: ['fw-rules'] };
    case 'ssh':
      return { server: ['ssh-keys'] };
    case 'cleanup':
      return { server: ['cleanup'] };
    case 'backup':
      return { server: [], global: ['backups'] };
    case 'server':
      return { server: kind === 'server:ip' ? ['client-host'] : [...SERVICE_KEYS, 'access'] };
    case 'command':
      return { server: [...SERVICE_KEYS, 'access'] };
    case 'gclients':
      return { server: [...SERVICE_KEYS, 'gclient-owners'] };
    default:
      return { server: [] };
  }
}

/**
 * Обновление кэша по событиям панели; вызывается один раз в лейауте. Метрики (раз в 2 с, пока
 * открыта вкладка) приходят с цифрами - они кладутся в список и карточку сервера без запроса.
 * Снимки (раз в 5 минут) - точечно: список и карточка своего сервера, не чаще раза в 5 с. Связь,
 * изменения и действия - сразу; по концу действия - ещё и данные вкладок, которые оно меняет
 * (вид действия приходит только в action.started), а после обновления сервиса - проверка версий.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const dirty = new Set<string>();
    const kinds = new Map<string, string>();
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
      if (ev.type === 'action.started' && ev.actionId && ev.kind) kinds.set(ev.actionId, ev.kind);
      if (ev.type === 'action.finished') {
        void qc.invalidateQueries({ queryKey: ['actions'] });
        const { serverId, actionId } = ev;
        // начало могло быть до открытия страницы - тогда вид есть в карточке сервера
        const kind =
          actionId &&
          (kinds.get(actionId) ??
            qc
              .getQueryData<ServerDetail>(['servers', serverId])
              ?.activeActions.find((a) => a.id === actionId)?.kind);
        if (actionId) kinds.delete(actionId);
        if (kind && serverId) {
          const stale = staleAfter(kind);
          // свой запрос вкладки после действия не прерываем: он держит её кнопки до ответа
          const keep = { cancelRefetch: false };
          for (const k of stale.server)
            void qc.invalidateQueries({ queryKey: [k, serverId] }, keep);
          for (const k of stale.global ?? []) void qc.invalidateQueries({ queryKey: [k] }, keep);
          if (SERVICE_UPDATE_ACTIONS.has(kind)) void checkUpdates(qc, serverId);
        }
      }
    });
    return () => {
      un();
      if (flush) clearTimeout(flush);
    };
  }, [qc]);
}
