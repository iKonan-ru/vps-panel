/** Ответы API панели, общие для сервера и интерфейса. */

// ---- Версия панели ----

export type PanelChannel = 'stable' | 'beta';

export interface PanelRelease {
  version: string;
  prerelease: boolean;
  notes: string;
  url: string;
  publishedAt: string;
}

export interface PanelUpdateSettings {
  channel: PanelChannel;
  /** Ставить новую версию канала самой, в час autoHour (UTC). */
  autoUpdate: boolean;
  autoHour: number;
  /** После обновления панели раскатить агентов (по одному). */
  agentsAuto: boolean;
}

export interface PanelUpdateView extends PanelUpdateSettings {
  current: string;
  /** Установка из релиза: панель может обновиться сама. */
  managed: boolean;
  /** Новее текущей в своём канале, от новой к старой. */
  newer: PanelRelease[];
  checkedAt: string | null;
  error: string | null;
  /** Запрос обновления передан службе на хосте, ещё не подхвачен. */
  requested: string | null;
}

// ---- Доступность из России ----

/** От 80% зондов - видно, от 50% - частично, ниже - не видно. */
export type ReachLevel = 'ok' | 'partial' | 'bad';

/** Зонд проверки: город, сеть и её AS, дошёл ли; задержка - если дошёл. */
export interface ReachProbe {
  city: string;
  asn: number;
  network: string;
  ok: boolean;
  error?: string;
  rtt?: number;
}

export interface ReachPoint {
  at: string;
  percent: number;
  total: number;
  /** Медиана задержки проверки, мс. */
  rtt?: number;
}

export interface ReachTarget {
  key: string;
  title: string;
  kind: 'tcp' | 'tls';
  port: number;
  sni?: string;
  /** null - ещё нет итога. */
  percent: number | null;
  total: number;
  ok: number;
  errors: string[];
  /** Проверка не состоялась (квота Globalping, сеть). */
  error?: string | undefined;
  checkedAt: string | null;
  /** Медиана задержки последней проверки, мс; у MTProxyL её нет. */
  rtt?: number | undefined;
  history: ReachPoint[];
  /** Проверок подряд "не видно" и было ли уведомление о нём. */
  badStreak: number;
  notified: boolean;
  /** Кто проверяет: агент панели или сам MTProxyL. */
  source: 'agent' | 'mtproxyl';
}

export interface ServerReach {
  checkedAt: string | null;
  error?: string;
  /** Остаток квоты Globalping с адреса сервера после проверки. */
  remaining?: number;
  targets: ReachTarget[];
}

// ---- Доставка в Telegram ----

/** Доходят ли уведомления: по отправкам и проверке раз в 5 минут. */
export interface TgHealth {
  /** null - ещё не проверяли. */
  ok: boolean | null;
  /** С какого времени не доходит (первая неудача подряд). */
  failingSince: string | null;
  lastOkAt: string | null;
  /** Каким путём дошло последнее: direct, env, proxy:<id сервера>, agent:<id сервера>. */
  lastOkVia: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

export interface TgHealthView extends TgHealth {
  /** Сообщений ждут отправки. */
  pending: number;
  /** Заданы токен бота и чат (только в /api/notify/telegram/health). */
  configured?: boolean;
}

// ---- Выходы xray панели ----

/** Выход xray панели к VLESS Reality inbound-у сервера. */
export interface XrayOutbound {
  serverId: string;
  serverName: string;
  inboundId: number;
  inboundRemark: string;
  address: string;
  port: number;
  uuid: string;
  publicKey: string;
  shortId: string;
  sni: string;
  fingerprint: string;
  flow: string;
  updatedAt: string;
}

export type XrayCheck = { at: string; ok: boolean; ms: number; err: string | null };

/** Выход для интерфейса: uuid сокращён, ключей нет. */
export type XrayExitView = Omit<XrayOutbound, 'uuid' | 'publicKey' | 'shortId'> & {
  uuid: string;
  primary: boolean;
  lastCheck: XrayCheck | null;
};

export interface XrayStatus {
  configured: boolean;
  binary: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  /** Проверка основного выхода. */
  lastCheck: XrayCheck | null;
  outbound: XrayExitView | null;
  /** Все выходы по порядку: основной, затем запасные. */
  exits: XrayExitView[];
  /** Запасные: когда готовились и что не вышло по серверам. */
  spares: { at: string | null; errors: { server: string; error: string }[] };
}

// ---- Расширение Firefox ----

export interface FirefoxState {
  /** Подписанная версия расширения. */
  signed: string | null;
  busy: boolean;
  error: string | null;
  at: string | null;
}

export interface FirefoxView extends FirefoxState {
  keySet: boolean;
  id: string;
  /** Версия расширения в этой панели. */
  version: string | null;
}

// ---- Клиентские приложения ----

export type AppOs = 'android' | 'ios' | 'windows' | 'macos' | 'linux';

export interface AppLink {
  label: string;
  url: string;
  version?: string;
  note?: string;
}

export interface AppView {
  id: string;
  name: string;
  purpose: string;
  platforms: { os: AppOs; title: string; links: AppLink[] }[];
}

// ---- Движок MTProxyL ----

export interface EngineVersion {
  tag: string;
  date: string;
  prerelease: boolean;
  installed: boolean;
  /** Готовый образ есть в реестре. */
  image: boolean;
  /** Ставится без сборки на сервере. */
  ready: boolean;
}

export interface EngineInfo {
  current: string;
  binary: boolean;
  versions: EngineVersion[];
  /** Реестр образов не ответил: версии docker ставить нельзя. */
  registryError?: string;
}

// ---- Обновления сервисов ----

/** 3X-UI, ядро Xray в ней, MTProxyL (менеджер) и его веб-панель. */
export type ServiceUpdateKind = 'xui' | 'xray' | 'mtproxyl' | 'mtproxyl-panel';

export interface ServiceUpdate {
  kind: ServiceUpdateKind;
  title: string;
  current: string;
  latest: string;
}

// ---- Команды каталога ----

export type ParamType =
  | 'string'
  | 'password'
  | 'number'
  | 'port'
  | 'select'
  | 'bool'
  | 'text'
  | 'domain'
  /** Контейнер AWG, который есть на выбранном сервере. */
  | 'awg-container';

/** Вопрос формы команды; значение уходит в скрипт переменной окружения name. */
export interface CommandParamInfo {
  name: string;
  label: string;
  type: ParamType;
  default?: string;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Регулярное выражение для проверки. */
  pattern?: string;
  min?: number;
  max?: number;
  /** Секрет: не запоминается и не пишется в журнал. */
  secret?: boolean;
  /** Показывать только при таком значении другого параметра: { name: value }. */
  showIf?: Record<string, string>;
}

/** Команда каталога для интерфейса: без скриптов. */
export interface CommandInfo {
  id: string;
  title: string;
  group: 'install' | 'maintain';
  /** Сервис: команды одного сервиса показываются одной карточкой. */
  service?: string;
  description: string;
  params: CommandParamInfo[];
  hasPreflight: boolean;
  after?: string;
}

// ---- 3X-UI ----

/** Inbound 3X-UI для вкладки (GET /xui/inbound-list): без настроек клиентов. */
export interface XuiInboundRow {
  id: number;
  remark: string;
  enable: boolean;
  protocol: string;
  port: number;
  listen: string;
  network: string;
  security: string;
  sni: string;
  /** inbound другого узла группы 3X-UI */
  node: boolean;
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  excludeFromSub: boolean;
  /** исключён из глобальных клиентов */
  excluded: boolean;
  clients: number;
  clientsOff: number;
  online: number;
  panelClients: number;
  /** Через inbound идёт выход панели в Telegram: основной или запасной. */
  telegramExit: 'primary' | 'spare' | null;
}

/** Свой VLESS inbound сервера для страницы клиентов (GET /xui/inbounds). */
export interface XuiOwnInbound {
  id: number;
  remark: string;
  port: number;
  enable: boolean;
  security: string;
  excluded: boolean;
}
