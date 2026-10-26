import type {
  CascadeCheck,
  CascadeMode,
  CascadeTelegramCheck,
  GClientAccess,
  Inventory,
  Metrics,
  PortsyncConfig,
  WatchEvent,
} from '@vps/protocol';
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Последнее, что агент сообщил о сервере (колонка status_cache). */
export interface StatusCache {
  metrics?: Metrics;
  metricsAt?: string;
  inventory?: Inventory;
  /** Подсети экземпляров AWG (Address) по последнему опросу: выбор подсети для новых. */
  awgSubnets?: string[];
  /** Экземпляры AWG и их версии по последнему опросу (awg.status): матрица сервисов. */
  awgInstances?: { container: string; version: string; state: string }[];
}

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const admins = sqliteTable('admin', {
  id: text('id').primaryKey(),
  login: text('login').notNull().unique(),
  /** Имя в интерфейсе (меню пользователя); пусто - логин. */
  displayName: text('display_name').notNull().default(''),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  backupCodesHash: text('backup_codes_hash', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  createdAt: text('created_at').notNull().default(now),
});

export const sessions = sqliteTable('session', {
  id: text('id').primaryKey(),
  adminId: text('admin_id')
    .notNull()
    .references(() => admins.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
  ip: text('ip').notNull().default(''),
  userAgent: text('user_agent').notNull().default(''),
});

/** Справочник тегов серверов: цвет и подсказки при вводе. Сами теги сервера - server.tags. */
export const serverTags = sqliteTable('tag', {
  /** Имя; сравнение без учёта регистра (collate nocase в базе). */
  name: text('name').primaryKey(),
  color: text('color').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

export const loginAttempts = sqliteTable('login_attempt', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ip: text('ip').notNull(),
  login: text('login').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  at: text('at').notNull().default(now),
});

export const servers = sqliteTable('server', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  notes: text('notes').notNull().default(''),
  provider: text('provider').notNull().default(''),
  providerServerName: text('provider_server_name').notNull().default(''),
  providerUrl: text('provider_url').notNull().default(''),
  country: text('country').notNull().default(''),
  price: real('price'),
  currency: text('currency').notNull().default('RUB'),
  billingMonths: integer('billing_months').notNull().default(1),
  nextPaymentAt: text('next_payment_at'),
  agentTokenHash: text('agent_token_hash'),
  agentVersion: text('agent_version'),
  /** sha256 одноразового токена регистрации агента (сам токен - только в команде установки). */
  registrationToken: text('registration_token'),
  /** До какого времени действует токен регистрации (1 час). */
  registrationExpiresAt: text('registration_expires_at'),
  createdAt: text('created_at').notNull().default(now),
  lastSeenAt: text('last_seen_at'),
  /** Отпечаток ключа SSH-хоста (SHA256:...), запоминается при первом подключении. */
  hostKeyFingerprint: text('host_key_fingerprint').notNull().default(''),
  /** Участвует в глобальных клиентах (выключают у сервера, который скоро удалят). */
  gclients: integer('gclients', { mode: 'boolean' }).notNull().default(true),
  /** Inbound-ы 3X-UI, куда глобальные клиенты не добавляются (id). */
  xuiExcluded: text('xui_excluded', { mode: 'json' }).$type<number[]>().notNull().default([]),
  /** Адрес сервера в конфигах людей (имя под A-записью); null - host (IP). */
  clientHost: text('client_host'),
  /** Последний снимок состояния от агента (Inventory + метрики), JSON. */
  statusCache: text('status_cache', { mode: 'json' }).$type<StatusCache>(),
});

export const firewallRules = sqliteTable('firewall_rule', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  portFrom: integer('port_from').notNull(),
  portTo: integer('port_to').notNull(),
  proto: text('proto').notNull(),
  source: text('source').notNull().default('any'),
  action: text('action').notNull().default('allow'),
  comment: text('comment').notNull().default(''),
  createdAt: text('created_at').notNull().default(now),
});

/** Доступы к панелям и сервисам на сервере (логины, пароли, ссылки). Значения полей зашифрованы. */
export const access = sqliteTable('access', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('custom'),
  title: text('title').notNull(),
  fields: text('fields', { mode: 'json' })
    .$type<{ label: string; value: string; secret?: boolean }[]>()
    .notNull()
    .default([]),
  note: text('note').notNull().default(''),
  /** Порядок в блоке "Доступы" (перетаскиванием); при равных - по времени создания. */
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

/** Бэкап конфигов сервисов: файл в DATA_DIR/backups/<id>.tar.gz. */
export const backups = sqliteTable('backup', {
  id: text('id').primaryKey(),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
  serverName: text('server_name').notNull().default(''),
  hostname: text('hostname').notNull().default(''),
  createdAt: text('created_at').notNull().default(now),
  size: integer('size').notNull().default(0),
  sha256: text('sha256').notNull().default(''),
  manifest: text('manifest', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});

/** Последние ответы на вопросы команды для сервера (без секретов). */
export const commandDefaults = sqliteTable('command_default', {
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  commandId: text('command_id').notNull(),
  answers: text('answers', { mode: 'json' }).$type<Record<string, string>>().notNull(),
});

export const portsyncConfigs = sqliteTable('portsync_config', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  config: text('config', { mode: 'json' }).$type<PortsyncConfig>().notNull(),
});

export const actionLog = sqliteTable('action_log', {
  id: text('id').primaryKey(),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  startedAt: text('started_at').notNull().default(now),
  finishedAt: text('finished_at'),
  exitCode: integer('exit_code'),
  output: text('output').notNull().default(''),
  initiator: text('initiator').notNull().default('admin'),
});

export const settings = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Состояние бота администратора между перезапусками панели: key - "вид/ключ", значение JSON,
 * срок - мс с эпохи (просроченное бот не читает и удаляет).
 */
export const botState = sqliteTable('bot_state', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/**
 * Клиенты AWG, созданные панелью: приватный ключ хранится здесь (зашифрован SecretBox), на
 * VPN-сервере его нет. Пир и имя живут на сервере (конфиг и clientsTable), здесь - только то,
 * без чего нельзя выдать конфиг повторно.
 */
export const awgClients = sqliteTable('awg_client', {
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  container: text('container').notNull(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Глобальный клиент: человек с устройствами. token - токен подписки и
 * личной страницы (только в панели, перевыпускается кнопкой); xuiSubId - subId клиента в 3X-UI
 * на серверах, с токеном не связан (subId лежит в x-ui.db каждого сервера); slug -
 * латинское имя для 3X-UI (email) и MTProxyL (метка). Удаление мягкое: сверка убирает записи
 * на серверах, потом строку.
 */
export const gclients = sqliteTable('gclient', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  note: text('note').notNull().default(''),
  token: text('token').notNull().unique(),
  xuiSubId: text('xui_sub_id').notNull().default(''),
  slug: text('slug').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** null - все серверы и сервисы; список - только отмеченное (GClientAccess) */
  access: text('access', { mode: 'json' }).$type<GClientAccess>(),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull().default(now),
});

/** Устройство клиента: type - из DEVICES; awg20 - кроме AWG 3.1 ещё пир на экземпляре 2.0. */
export const gclientDevices = sqliteTable('gclient_device', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => gclients.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull().default(''),
  awg20: integer('awg20', { mode: 'boolean' }).notNull().default(false),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Привязка клиента к сервису сервера (желаемое и фактическое): VLESS и MTProxy - к человеку
 * (deviceId пусто), AWG - к устройству. ref - запись на сервере (email 3X-UI, метка MTProxyL,
 * "контейнер/ключ" AWG), secret - зашифрованный секрет (hex MTProxyL), links - кэш ссылок
 * для подписки. state: ok, pending (ждёт сверки), error (текст в error).
 */
export const gclientBindings = sqliteTable('gclient_binding', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => gclients.id, { onDelete: 'cascade' }),
  deviceId: text('device_id'),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  service: text('service').notNull(),
  ref: text('ref').notNull().default(''),
  secret: text('secret').notNull().default(''),
  links: text('links', { mode: 'json' }).$type<string[]>().notNull().default([]),
  state: text('state').notNull().default('pending'),
  error: text('error').notNull().default(''),
  /** VLESS: свой набор inbound-ов клиента на этом сервере (null - как у всех: свои минус исключённые). */
  xuiInbounds: text('xui_inbounds', { mode: 'json' }).$type<number[] | null>(),
  updatedAt: text('updated_at').notNull().default(now),
});

/**
 * Каскад VLESS: inbound на входе (свой порт), outbound к RAW-inbound-у выхода и правила
 * маршрутизации в шаблоне Xray входа. Шаблон на входе - источник правды о том, что стоит сейчас.
 */
export const cascades = sqliteTable('vless_cascade', {
  id: text('id').primaryKey(),
  /** Без внешнего ключа: при удалении сервера каскады снимаются с другой стороны и потом стираются. */
  entryServerId: text('entry_server_id').notNull(),
  entryInboundId: integer('entry_inbound_id'),
  entryPort: integer('entry_port'),
  entryRemark: text('entry_remark').notNull().default(''),
  exitServerId: text('exit_server_id').notNull(),
  exitInboundId: integer('exit_inbound_id').notNull(),
  mode: text('mode').$type<CascadeMode>().notNull().default('ru-direct'),
  directList: text('direct_list', { mode: 'json' }).$type<string[]>().notNull().default([]),
  exitList: text('exit_list', { mode: 'json' }).$type<string[]>().notNull().default([]),
  blockQuic: integer('block_quic', { mode: 'boolean' }).notNull().default(false),
  check: text('check_result', { mode: 'json' }).$type<CascadeCheck | null>(),
  error: text('error'),
  createdAt: text('created_at').notNull().default(now),
  /** Telegram входа (MTProxyL) ходит через этот выход: socks-inbound на 127.0.0.1 в Xray входа. */
  telegram: integer('telegram', { mode: 'boolean' }).notNull().default(false),
  telegramMain: integer('telegram_main', { mode: 'boolean' }).notNull().default(false),
  telegramPort: integer('telegram_port'),
  telegramCheck: text('telegram_check', { mode: 'json' }).$type<CascadeTelegramCheck | null>(),
});

/**
 * Расширение для браузера у клиента: последний отчёт установки. id - "<клиент>:<установка>";
 * установка версии без отчётов - "legacy-<браузер>".
 */
export const gclientExts = sqliteTable('gclient_ext', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => gclients.id, { onDelete: 'cascade' }),
  browser: text('browser').notNull().default('other'),
  version: text('version'),
  enabled: integer('enabled', { mode: 'boolean' }),
  serverId: text('server_id'),
  error: text('error').notNull().default(''),
  seenAt: text('seen_at').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Документы для каналов OpenFlux глобальных клиентов: Яндекс Документы (vyandex) и публичные
 * документы Mail.ru (mailru) с редактированием по ссылке. Документ - на один канал: binding_id -
 * привязка, которой он выдан (null - свободен).
 */
export const openfluxDocs = sqliteTable('openflux_doc', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  url: text('url').notNull().unique(),
  bindingId: text('binding_id').references(() => gclientBindings.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Правило уведомления о подключении клиента (WatchRuleBody): server_id, service и device_id -
 * null значит "любой". state - что панель видела на последней проверке (WatchState).
 */
export const clientWatches = sqliteTable('client_watch', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => gclients.id, { onDelete: 'cascade' }),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  service: text('service'),
  deviceId: text('device_id'),
  event: text('event').$type<WatchEvent>().notNull().default('both'),
  delayMinutes: integer('delay_minutes').notNull().default(5),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  state: text('state', { mode: 'json' }).$type<WatchState | null>(),
  createdAt: text('created_at').notNull().default(now),
});

/** Наблюдение по правилу: переживает перезапуск панели, чтобы не повторять сообщения. */
export interface WatchState {
  /** первая проверка прошла: дальше - сообщения о переходах */
  primed: boolean;
  status: 'up' | 'down' | 'unknown';
  /** не на связи дольше задержки */
  offline: boolean;
  /** последняя активность клиента, ISO */
  lastSeen: string | null;
  /** начало текущего отрезка "не на связи" по наблюдению панели, ISO */
  downSince: string | null;
  checkedAt: string;
  note: string;
}
