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
  /** галочка "участвует в глобальных клиентах" */
  enabled: boolean;
  /** участвует на деле: включён и не сервер панели */
  active: boolean;
  /** сервер, на котором стоит панель: клиенты на нём не заводятся */
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
