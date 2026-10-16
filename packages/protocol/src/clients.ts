/**
 * Глобальные клиенты: ответы API панели. Одни типы у сервера и интерфейса:
 * интерфейс не описывает их сам и не разбирает внутренние форматы сервера (ref привязки AWG,
 * порядок ссылок WDTT).
 */
export type GService = 'xui' | 'mtproxyl' | 'wdtt' | 'awg' | 'openflux' | 'naive';
export type GBindingState = 'ok' | 'pending' | 'error';
export const G_SERVICES: GService[] = ['xui', 'mtproxyl', 'awg', 'wdtt', 'openflux', 'naive'];

/**
 * Доступ клиента: на каких серверах какие сервисы заводятся. null - все серверы и сервисы
 * (новые тоже); список - только отмеченное, новое само не добавляется.
 */
export type GClientAccess = { serverId: string; services: GService[] }[] | null;

export interface GDevice {
  id: string;
  name: string;
  type: string;
  awg20: boolean;
}

/** Строка списка клиентов. */
export interface GClientRow {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  createdAt: string;
  devices: GDevice[];
  states: Record<GBindingState, number>;
  servers: string[];
  /** доступ выборочный (не все серверы и сервисы) */
  limited: boolean;
  /** выборочный доступ: серверы и сервисы (null - все); для фильтров списка */
  access: GClientAccess;
}

/**
 * Расширение для браузера у клиента (одна установка): последний отчёт расширения. Отчёт - при
 * каждом изменении и раз в 15 минут, пока браузер открыт. version null - старая версия без
 * отчётов: известно только, когда она брала подписку (раз в 12 часов и при открытии окна).
 */
export interface GBrowserExt {
  id: string;
  browser: 'chrome' | 'firefox' | 'other';
  version: string | null;
  /** версия старее той, что раздаёт панель */
  outdated: boolean;
  /** прокси включён; null - неизвестно (старая версия) */
  enabled: boolean | null;
  /** выбранный сервер: "Авто" или имя сервера; null - неизвестно */
  server: string | null;
  /**
   * Сервер, через который идёт браузер (id): выбранный, при "Авто" - первый в цепочке подписки,
   * агент которого на связи; null - неизвестно (старая версия, серверов нет).
   */
  viaServerId: string | null;
  /** что видит человек в окне расширения: ссылка не действует, прокси не отвечает */
  error: string;
  seenAt: string;
  /** на связи: отчёт не старше 20 минут (у старой версии - всегда false) */
  online: boolean;
}

/** Привязка клиента к сервису на сервере. */
export interface GBinding {
  id: string;
  clientId: string;
  deviceId: string | null;
  serverId: string;
  serverName: string;
  service: GService;
  ref: string;
  state: GBindingState;
  error: string;
  updatedAt: string;
  linkCount: number;
  /** AWG: версия экземпляра, контейнер и ключ пира (пока пир не создан - пустые). */
  awg: { major: string; container: string; publicKey: string } | null;
  /** VLESS: свой набор inbound-ов (null - как у всех). */
  xuiInbounds: number[] | null;
}

/** Ход сверки (GET /api/gclients/syncing): по серверам - сделано, текущее, ошибки, итоги. */
export interface GSyncState {
  syncing: boolean;
  stopping: boolean;
  startedAt: string | null;
  progress: {
    server: string;
    done: number;
    total: number;
    current: string;
    errors: number;
    startedAt: string;
    last: string[];
    finished: boolean;
  }[];
}

/** Клиент 3X-UI для вкладки (без UUID и subId); panel - если это клиент панели. */
export interface XuiClientRow {
  email: string;
  comment: string;
  enable: boolean;
  inboundIds: number[];
  up: number;
  down: number;
  totalGB: number;
  expiryTime: number;
  online: boolean;
  panel: { clientId: string; name: string; custom: boolean } | null;
}

export interface GClientDetail {
  client: {
    id: string;
    name: string;
    note: string;
    enabled: boolean;
    token: string;
    createdAt: string;
    access: GClientAccess;
  };
  /** Сверка с серверами идёт сейчас: "Сверить сейчас" ждёт её конца. */
  syncing: boolean;
  subscription: { url: string; page: string; temporary: boolean };
  devices: GDevice[];
  bindings: GBinding[];
  browserExt: GBrowserExt[];
}

/** Ссылки привязки; у WDTT - ещё по именам (qwdtt:// для обоих клиентов и старая wdtt://). */
export interface GBindingLinks {
  links: string[];
  wdtt?: { qwdtt: string; wdtt: string };
}

/**
 * Чья запись в сервисе сервера (вкладки сервисов показывают ссылку на клиента): key - email 3X-UI,
 * метка MTProxyL, ключ пира AWG, имя канала OpenFlux; у WDTT - 16 hex sha256 пароля (сам пароль
 * сюда не попадает).
 */
export interface GOwner {
  service: GService;
  key: string;
  clientId: string;
  client: string;
  device: string;
}

/** Сервер в разделе "Клиенты": участие в глобальных клиентах. */
export interface GServer {
  id: string;
  name: string;
  online: boolean;
  /** галочка "участвует в глобальных клиентах" (сервер панели - только явно включённый) */
  enabled: boolean;
  /** участвует на деле */
  active: boolean;
  /** сервер, на котором стоит панель: 80 и 443 держит панель */
  panelHost: boolean;
  xui: boolean;
  awg: boolean;
  mtproxyl: boolean;
  wdtt: boolean;
  openflux: boolean;
  /** прокси для браузера */
  naive: boolean;
  xuiExcluded: number[];
}

/**
 * Ответ агента clients.stats: счётчики всех сервисов сервера по ключам записей. Раздела нет -
 * сервиса нет или он не ответил (причина - в errors под тем же именем). Без UUID, паролей,
 * ключей и адресов клиентов.
 */
export interface ClientStatsSnapshot {
  /** время снимка на сервере, unix мс */
  at: number;
  /** 3X-UI по email: up - от клиента, down - к клиенту, lastOnline - мс */
  xui?: Record<string, { up: number; down: number; lastOnline: number; online: boolean }>;
  /** AWG: контейнер -> ключ пира; rx - от клиента, tx - к клиенту, handshake - unix с */
  awg?: Record<string, Record<string, { handshake: number; rx: number; tx: number }>>;
  /** telemt по метке: in - от клиента, out - к клиенту (с запуска), подключений и адресов сейчас */
  mtproxyl?: Record<string, { in: number; out: number; conns: number; ips: number }>;
  /** WDTT по ключу пароля (wdttKey): up - от клиента, down - к клиенту, устройств на связи */
  wdtt?: Record<string, { up: number; down: number; devices: number }>;
  /** OpenFlux по имени канала: служба работает, с какого времени, прямых соединений */
  openflux?: Record<string, { active: boolean; since: string; conns: number }>;
  /** прокси для браузера: служба работает */
  naive?: boolean;
  errors: Record<string, string>;
}

/**
 * Подключение привязки сейчас: online - на связи; idle - не на связи (lastSeen - когда был, если
 * известно); never - ни разу не подключался; running - сервис работает, а подключение не видно
 * (naive, OpenFlux не через direct); down - сервис не работает или не ответил; missing - записи
 * на сервере нет (ждёт сверки); offline - сервер не в сети; outdated - агент без clients.stats.
 */
export type GLiveState =
  | 'online'
  | 'idle'
  | 'never'
  | 'running'
  | 'down'
  | 'missing'
  | 'offline'
  | 'outdated';

/** Живая статистика привязки. Байты: in - от клиента, out - к клиенту. */
export interface GLiveBinding {
  bindingId: string;
  state: GLiveState;
  /** последняя активность, ISO; null - неизвестна */
  lastSeen: string | null;
  /** скорость, байт/с; null - пока неизвестна (первый снимок, обнуление счётчика) */
  rateIn: number | null;
  rateOut: number | null;
  /** всего по счётчику сервиса; null - сервис не считает */
  totalIn: number | null;
  totalOut: number | null;
  /** счётчик "всего" живёт с запуска сервиса (AWG, MTProxy), а не всё время */
  sinceStart: boolean;
  /** подключений (MTProxy, прямых у OpenFlux), адресов (MTProxy), устройств (WDTT) */
  conns: number | null;
  ips: number | null;
  devices: number | null;
  /** пояснение: причина down, что значит running */
  note: string;
}

/** Сервер в живой статистике клиента. */
export interface GLiveServer {
  serverId: string;
  online: boolean;
  /** агент не знает clients.stats: нужно обновить агента */
  outdated: boolean;
  /** время снимка, ISO; null - снимка нет */
  at: string | null;
  /** снимок не получен (агент не ответил) */
  error: string;
}

/** GET /api/gclients/:id/live */
export interface GClientLive {
  at: string;
  servers: GLiveServer[];
  bindings: GLiveBinding[];
}
