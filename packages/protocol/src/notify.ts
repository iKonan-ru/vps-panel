/**
 * Уведомления в Telegram: каталог событий по группам, один на сервер и интерфейс. У события
 * может быть число-параметр (порог, задержка).
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
  'updPanel',
  'diskFull',
  'cpuHigh',
  'loginFails',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Числа к событиям: задержка "сервер пропал", порог банов, за сколько дней об оплате. */
export interface NotifyParams {
  offlineMinutes: number;
  banThreshold: number;
  paymentDays: number;
  /** диск заполнен на столько процентов */
  diskPercent: number;
  /** загрузка CPU выше этого процента CPU_HIGH_MINUTES минут подряд */
  cpuPercent: number;
  /** неудачных входов в панель за час */
  loginFails: number;
}
export const NOTIFY_PARAM_DEFAULTS: NotifyParams = {
  offlineMinutes: 3,
  banThreshold: 10,
  paymentDays: 3,
  diskPercent: 90,
  cpuPercent: 90,
  loginFails: 10,
};
export const NOTIFY_PARAM_LIMITS: Record<keyof NotifyParams, [number, number]> = {
  offlineMinutes: [1, 120],
  banThreshold: [1, 10_000],
  paymentDays: [0, 60],
  diskPercent: [50, 99],
  cpuPercent: [50, 100],
  loginFails: [1, 1000],
};
/** Сколько минут подряд загрузка CPU должна быть выше порога. */
export const CPU_HIGH_MINUTES = 15;

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
        hint: 'сервер не в сети дольше заданного времени; перезагрузка и обновление агента не в счёт',
        param: { key: 'offlineMinutes', label: 'через, мин' },
      },
      {
        key: 'online',
        title: 'Сервер снова в сети',
        hint: 'после уведомления \u00abСервер пропал\u00bb',
      },
      {
        key: 'serviceDown',
        title: 'Сервис упал',
        hint: 'не работает дольше 2\u00a0минут',
      },
      {
        key: 'serviceUp',
        title: 'Сервис снова работает',
        hint: 'после уведомления \u00abСервис упал\u00bb',
      },
      {
        key: 'diskFull',
        title: 'Заканчивается место на диске',
        hint: 'и когда место освободилось',
        param: { key: 'diskPercent', label: 'занято, %' },
      },
      {
        key: 'cpuHigh',
        title: 'Долго высокая загрузка CPU',
        hint: '15\u00a0минут подряд выше порога; и когда спала',
        param: { key: 'cpuPercent', label: 'выше, %' },
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
      { key: 'reachMtproxy', title: 'MTProxyL не виден', hint: 'по проверке MTProxyL' },
      { key: 'reachBack', title: 'Снова виден', hint: 'после уведомления \u00abне виден\u00bb' },
    ],
  },
  {
    id: 'security',
    title: 'Безопасность',
    events: [
      { key: 'auditNew', title: 'Новые критичные замечания аудита' },
      { key: 'auditClosed', title: 'Критичные замечания устранены' },
      {
        key: 'bans',
        title: 'Рост блокировок fail2ban',
        hint: 'не чаще раза в час на сервер',
        param: { key: 'banThreshold', label: 'блокировок в час' },
      },
      {
        key: 'loginFails',
        title: 'Неудачные попытки входа в панель',
        hint: 'не чаще раза в час',
        param: { key: 'loginFails', label: 'попыток в час' },
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
        key: 'updPanel',
        title: 'Вышла новая версия панели',
        hint: 'в выбранном канале обновлений',
      },
      {
        key: 'backupFail',
        title: 'Резервная копия панели не создана или не отправлена',
      },
    ],
  },
];

export type NotifyEvents = Record<NotifyEvent, boolean>;

export const NOTIFY_DEFAULTS: NotifyEvents = Object.fromEntries(
  NOTIFY_EVENTS.map((k) => [k, true]),
) as NotifyEvents;

/** События из сохранённого JSON: чего нет - по умолчанию. */
export function readNotifyEvents(saved: Record<string, unknown>): NotifyEvents {
  const out: NotifyEvents = { ...NOTIFY_DEFAULTS };
  for (const k of NOTIFY_EVENTS) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean;
  return out;
}
