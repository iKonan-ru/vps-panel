/**
 * Уведомления в Telegram: каталог событий по группам - один на сервер (правила, lib/notify.ts)
 * и интерфейс (окно настройки). У события может быть число-параметр (порог, задержка).
 */

export const NOTIFY_EVENTS = [
  'offline',
  'online',
  'serviceDown',
  'serviceUp',
  'reachAddr',
  'reachInbound',
  'reachMtproxy',
  'reachBack',
  'auditNew',
  'auditClosed',
  'bans',
  'pkgUpdates',
  'updXui',
  'updXray',
  'updMtproxyl',
  'updMtproxylPanel',
  'payment',
  'backupFail',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Числа к событиям: задержка "сервер пропал", порог банов, за сколько дней об оплате. */
export interface NotifyParams {
  offlineMinutes: number;
  banThreshold: number;
  paymentDays: number;
}
export const NOTIFY_PARAM_DEFAULTS: NotifyParams = {
  offlineMinutes: 3,
  banThreshold: 10,
  paymentDays: 3,
};
export const NOTIFY_PARAM_LIMITS: Record<keyof NotifyParams, [number, number]> = {
  offlineMinutes: [1, 120],
  banThreshold: [1, 10_000],
  paymentDays: [0, 60],
};

export interface NotifyEventInfo {
  key: NotifyEvent;
  title: string;
  hint?: string;
  /** Число к событию и подпись к нему ("через, мин"). */
  param?: { key: keyof NotifyParams; label: string };
}

export interface NotifyGroup {
  id: string;
  title: string;
  events: NotifyEventInfo[];
}

export const NOTIFY_GROUPS: NotifyGroup[] = [
  {
    id: 'servers',
    title: 'Серверы и сервисы',
    events: [
      {
        key: 'offline',
        title: 'Сервер пропал',
        hint: 'агент не на связи дольше заданного времени (перезагрузку и обновление агента не считаем)',
        param: { key: 'offlineMinutes', label: 'через, мин' },
      },
      {
        key: 'online',
        title: 'Сервер снова на связи',
        hint: 'после отправленного "сервер пропал"',
      },
      {
        key: 'serviceDown',
        title: 'Сервис упал',
        hint: 'xray 3X-UI, MTProxyL, контейнер AWG, WDTT, naive, OpenFlux - не работает дольше 2 минут',
      },
      {
        key: 'serviceUp',
        title: 'Сервис снова работает',
        hint: 'после отправленного "сервис упал"',
      },
    ],
  },
  {
    id: 'reach',
    title: 'Доступность из России',
    events: [
      { key: 'reachAddr', title: 'Адрес сервера не виден', hint: 'две проверки подряд ниже 50%' },
      {
        key: 'reachInbound',
        title: 'Inbound 3X-UI не виден',
        hint: 'две проверки подряд ниже 50%',
      },
      { key: 'reachMtproxy', title: 'MTProxyL не виден', hint: 'по проверке самого MTProxyL' },
      { key: 'reachBack', title: 'Снова виден', hint: 'после отправленного "не виден"' },
    ],
  },
  {
    id: 'security',
    title: 'Безопасность',
    events: [
      { key: 'auditNew', title: 'Новые критичные замечания аудита' },
      { key: 'auditClosed', title: 'Критичные замечания закрыты' },
      {
        key: 'bans',
        title: 'Рост банов fail2ban',
        hint: 'не чаще раза в час на сервер',
        param: { key: 'banThreshold', label: 'банов в час' },
      },
      {
        key: 'pkgUpdates',
        title: 'Обновления безопасности ждут установки',
        hint: 'не чаще раза в сутки на сервер',
      },
    ],
  },
  {
    id: 'updates',
    title: 'Новые версии сервисов',
    events: [
      { key: 'updXui', title: '3X-UI' },
      { key: 'updXray', title: 'Xray в 3X-UI' },
      { key: 'updMtproxyl', title: 'MTProxyL' },
      { key: 'updMtproxylPanel', title: 'Веб-панель MTProxyL' },
    ],
  },
  {
    id: 'hosting',
    title: 'Хостинг',
    events: [
      {
        key: 'payment',
        title: 'Скоро оплата',
        hint: 'один раз на дату оплаты',
        param: { key: 'paymentDays', label: 'за, дней' },
      },
    ],
  },
  {
    id: 'panel',
    title: 'Панель',
    events: [
      {
        key: 'backupFail',
        title: 'Бэкап панели не создан или не отправлен',
        hint: 'сам бэкап в Telegram - в блоке "Бэкап панели"',
      },
    ],
  },
];

export type NotifyEvents = Record<NotifyEvent, boolean>;

export const NOTIFY_DEFAULTS: NotifyEvents = Object.fromEntries(
  NOTIFY_EVENTS.map((k) => [k, true]),
) as NotifyEvents;

/**
 * События из сохранённого JSON: новые ключи как есть, старые группы (offline, audit, bans,
 * updates, reach - до 12.10) раскладываются на события, которых в сохранённом ещё нет.
 */
export function readNotifyEvents(saved: Record<string, unknown>): NotifyEvents {
  const out: NotifyEvents = { ...NOTIFY_DEFAULTS };
  const legacy: Record<string, NotifyEvent[]> = {
    offline: ['offline', 'online'],
    audit: ['auditNew', 'auditClosed'],
    updates: ['pkgUpdates', 'updXui', 'updXray', 'updMtproxyl', 'updMtproxylPanel', 'payment'],
    reach: ['reachAddr', 'reachInbound', 'reachMtproxy', 'reachBack'],
  };
  for (const [old, keys] of Object.entries(legacy))
    if (typeof saved[old] === 'boolean')
      for (const k of keys) if (!(k in saved)) out[k] = saved[old] as boolean;
  for (const k of NOTIFY_EVENTS) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean;
  return out;
}
