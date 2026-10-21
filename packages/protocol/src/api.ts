import type { Inventory } from './agent.js';
import type { ServerSummary } from './server.js';

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
  /** Сколько целей проверено по токену панели: своей квоты сервера на них не хватило. */
  byToken?: number;
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
  /**
   * Запасные: когда готовились и что не вышло по серверам; off - серверы, которые владелец не
   * разрешил брать запасными (остальные с 3X-UI - можно, в том числе новые).
   */
  spares: { at: string | null; errors: { server: string; error: string }[]; off: string[] };
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

// ---- Карточка сервера ----

export interface ServerDetail extends ServerSummary {
  inventory: Inventory | null;
  metricsAt: string | null;
  /** Незавершённые действия на сервере: после перезагрузки страницы виден их ход. */
  activeActions: { id: string; kind: string; title: string; startedAt: string }[];
}

// ---- Резервные копии серверов ----

/** Компонент архива копии. */
export interface BackupComponent {
  id: string;
  title: string;
  paths?: string[];
  containers?: string[];
  sizeBytes: number;
}

export interface BackupInfo {
  id: string;
  serverId: string | null;
  serverName: string;
  hostname: string;
  createdAt: string;
  size: number;
  sha256: string;
  /** setup - состав сервисов: по нему копию разворачивает настройка сервера. */
  manifest: { components?: BackupComponent[]; setup?: unknown };
}

// ---- Безопасность и firewall ----

/** Что исправит шаг безопасности (baseline.plan агента). */
export interface BaselinePlan {
  steps: { id: string; title: string; needed: boolean; detail?: string; blocker?: string }[];
  ports: { port: number; proto: string; process: string; action: 'open' | 'close' }[];
  blockers: string[];
  canApply: boolean;
  sshPort: number;
  rootKeys: number;
}

/** /etc/vps-portsync.conf сервера. */
export interface PortsyncConfig {
  admin_ips: string[];
  deny_public_ports: string[];
  extra_allow: string[];
  known_processes: string[];
  docker_policy: 'published' | 'explicit';
  allow_ping: boolean;
  wan_interface: string;
  ssh_port: number;
}

/** Ручное правило ufw. */
export interface RuleInput {
  portFrom: number;
  portTo?: number;
  proto: 'tcp' | 'udp' | 'any';
  source: string;
  action: 'allow' | 'deny';
  comment: string;
}

/** Последняя проверка обновления компонента сервера. */
export interface ComponentVersion {
  latest: string;
  available: boolean;
  /** Версия на момент проверки. */
  current?: string;
  detail?: string;
  /** Почему проверить не удалось. */
  error?: string;
  checkedAt?: string;
}

// ---- 3X-UI: сведения агента и статус ----

export interface XuiInfo {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  version: string;
  db: string;
  panelPort: number;
  listen: string;
  basePath: string;
  https: boolean;
  certFile: string;
  twoFactor: boolean;
  subEnabled: boolean;
  subPort: number;
  inbounds: number;
  log: string;
  errors: string[];
}

/** server/status 3X-UI. */
export interface XuiServerStatus {
  cpu?: number;
  mem?: { current: number; total: number };
  uptime?: number;
  xray?: { state: string; version: string; errorMsg?: string };
  appStats?: { threads: number; mem: number; uptime: number };
}

/**
 * Каскад VLESS: клиент подключается к входу (обычно российский сервер), трафик уходит на выход
 * (зарубежный сервер). all - всё через выход; ru-direct - российское с входа напрямую, остальное
 * через выход; blocked - через выход только заблокированное в России, остальное напрямую.
 */
export type CascadeMode = 'all' | 'ru-direct' | 'blocked';
export const CASCADE_MODES: readonly CascadeMode[] = ['all', 'ru-direct', 'blocked'];

/** Последняя проверка выхода с входа (testOutbound 3X-UI). */
export interface CascadeCheck {
  at: string;
  ok: boolean;
  /** Задержка запроса через выход, мс. */
  ms: number;
  error: string | null;
}

export interface CascadeView {
  id: string;
  entryServerId: string;
  /** Inbound входа (null - ещё не создан или удалён в 3X-UI). */
  entryInboundId: number | null;
  entryPort: number | null;
  entryRemark: string;
  exitServerId: string;
  exitServerName: string;
  exitInboundId: number;
  mode: CascadeMode;
  /** Свои списки: домены (example.com, regexp:..., geosite:...), IP и подсети. */
  directList: string[];
  exitList: string[];
  blockQuic: boolean;
  check: CascadeCheck | null;
  /** Последняя ошибка применения на входе. */
  error: string | null;
  createdAt: string;
  /** Telegram (MTProxyL входа) ходит через этот выход. */
  telegram: boolean;
  /** Основной выход Telegram: через него почти всё, остальные - запасные. */
  telegramMain: boolean;
  /** Последняя проверка пути Telegram: адрес, с которым MTProxyL входа выходит наружу. */
  telegramCheck: CascadeTelegramCheck | null;
  /** Сейчас Telegram идёт через этот выход (основной или запасной вместо него). */
  telegramActive: boolean;
  /** Выход не отвечает или каскад не собран: в маршрутах Telegram его нет. */
  telegramDown: boolean;
}

export interface CascadeTelegramCheck {
  at: string;
  ok: boolean;
  /** Внешний адрес через выход (должен быть адресом выхода). */
  ip: string | null;
  error: string | null;
}

/** Каскад Telegram на входе: MTProxyL входа ходит в Telegram через выходы отмеченных каскадов. */
export interface CascadeTelegramState {
  /** Можно ли отмечать каскады этого входа для Telegram. */
  available: boolean;
  /** Почему нельзя (нет MTProxyL, сервер панели). */
  reason: string | null;
  /** Последняя ошибка настройки MTProxyL входа. */
  error: string | null;
}

/** Каскад, который выходит через этот сервер (строка на вкладке 3X-UI выхода). */
export interface CascadeVia {
  id: string;
  entryServerId: string;
  entryServerName: string;
  exitInboundId: number;
}

/** Inbound выхода, через который можно провести каскад (VLESS Reality RAW, свой). */
export interface CascadeExitInbound {
  id: number;
  remark: string;
  port: number;
  enable: boolean;
}

export interface CascadeExitOption {
  serverId: string;
  serverName: string;
  online: boolean;
  /** Почему сервер не подходит (нет 3X-UI, нет токена, нет RAW Reality). */
  reason: string | null;
  inbounds: CascadeExitInbound[];
}

/** Значения окна добавления каскада. */
export interface CascadeNewInfo {
  port: number;
  exits: CascadeExitOption[];
  /** Нет geosite_RU.dat / geoip_RU.dat на входе: режим blocked недоступен. */
  geoRu: boolean;
  /** Агент входа понимает тело-форму (без этого каскад не настроить). */
  agentReady: boolean;
}

export interface CascadesView {
  cascades: CascadeView[];
  via: CascadeVia[];
  telegram: CascadeTelegramState;
}

/**
 * Откуда брать кандидатов цели Reality: зарубежные или российские сайты, адреса рядом с
 * сервером (его /24).
 */
export type RealityPreset = 'foreign' | 'ru' | 'nearby';
export const REALITY_PRESETS: readonly RealityPreset[] = ['foreign', 'ru', 'nearby'];

/** Свой адрес, который не подошёл для Reality, и почему. */
export interface RealityRejected {
  target: string;
  reason: string;
}
