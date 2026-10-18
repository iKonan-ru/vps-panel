import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

/**
 * Открывает базу и накатывает схему: таблицы создаются идемпотентно по итоговой схеме
 * (BOOTSTRAP_SQL), изменения после неё - пронумерованными шагами в migrate.
 */
export function createDb(dataDir: string) {
  const file = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'panel.db');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const existed = Boolean(
    sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = 'server'").get(),
  );
  sqlite.exec(BOOTSTRAP_SQL);
  migrate(sqlite, existed);
  return drizzle(sqlite, { schema });
}

/**
 * Версия итоговой схемы BOOTSTRAP_SQL (pragma user_version): новая база сразу получает её.
 * Базу старее этой версии панель не поднимет: шагов к ней нет.
 */
const BASE_VERSION = 19;

/**
 * Шаги после BASE_VERSION для уже созданных баз: шаг i в списке - версия BASE_VERSION + i + 1,
 * применённые помнит pragma user_version. Каждый шаг идемпотентен (новая база уже содержит его
 * результат в BOOTSTRAP_SQL). Новый шаг - только в конец списка.
 */
const STEPS: ((sqlite: Database.Database) => void)[] = [
  // 20: адрес сервера в конфигах людей (имя вместо IP) - только добавление столбца
  (sqlite) => {
    const cols = sqlite.prepare('pragma table_info(server)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'client_host'))
      sqlite.exec('alter table server add column client_host text');
  },
  // 21: группы уведомлений (offline, audit, updates, reach) -> события
  (sqlite) => {
    const row = sqlite.prepare("select value from setting where key = 'tg_events'").get() as
      | { value: string }
      | undefined;
    if (!row) return;
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      return;
    }
    const groups: Record<string, string[]> = {
      offline: ['online'],
      audit: ['auditNew', 'auditClosed'],
      updates: ['pkgUpdates', 'updXui', 'updXray', 'updMtproxyl', 'updMtproxylPanel', 'payment'],
      reach: ['reachAddr', 'reachInbound', 'reachMtproxy', 'reachBack'],
    };
    for (const [group, keys] of Object.entries(groups)) {
      if (typeof saved[group] !== 'boolean') continue;
      for (const k of keys) if (!(k in saved)) saved[k] = saved[group];
      if (group !== 'offline') delete saved[group];
    }
    sqlite
      .prepare("update setting set value = ? where key = 'tg_events'")
      .run(JSON.stringify(saved));
  },
  // 22: каскады VLESS - новая таблица vless_cascade (её же создаёт BOOTSTRAP_SQL)
  (sqlite) => {
    sqlite.exec(`create table if not exists vless_cascade (
  id text primary key, entry_server_id text not null,
  entry_inbound_id integer, entry_port integer, entry_remark text not null default '',
  exit_server_id text not null,
  exit_inbound_id integer not null, mode text not null default 'ru-direct',
  direct_list text not null default '[]', exit_list text not null default '[]',
  block_quic integer not null default 0, check_result text, error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
  },
];

/** Шаги, которых база ещё не видела, - по порядку, каждый с отметкой версии. */
function migrate(sqlite: Database.Database, existed: boolean) {
  let done = sqlite.pragma('user_version', { simple: true }) as number;
  if (done < BASE_VERSION) {
    if (existed)
      throw new Error(
        `база панели версии ${done} старее поддерживаемой (${BASE_VERSION}): нужна панель той версии`,
      );
    sqlite.pragma(`user_version = ${BASE_VERSION}`);
    done = BASE_VERSION;
  }
  STEPS.forEach((step, i) => {
    const v = BASE_VERSION + i + 1;
    if (v <= done) return;
    sqlite.transaction(() => {
      step(sqlite);
      sqlite.pragma(`user_version = ${v}`);
    })();
  });
}

const BOOTSTRAP_SQL = `
create table if not exists admin (
  id text primary key, login text not null unique, password_hash text not null,
  totp_secret text, totp_enabled integer not null default 0,
  backup_codes_hash text not null default '[]',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists session (
  id text primary key, admin_id text not null references admin(id) on delete cascade,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at text not null, ip text not null default '', user_agent text not null default ''
);
create table if not exists login_attempt (
  id integer primary key autoincrement, ip text not null, login text not null,
  ok integer not null, at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists login_attempt_ip_at on login_attempt(ip, at);
create table if not exists server (
  id text primary key, name text not null, host text not null, ssh_port integer not null default 22,
  tags text not null default '[]', notes text not null default '',
  provider text not null default '', provider_server_name text not null default '',
  provider_url text not null default '', country text not null default '',
  price real, currency text not null default 'RUB', billing_months integer not null default 1,
  next_payment_at text, agent_token_hash text, agent_version text, registration_token text, registration_expires_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at text, status_cache text, host_key_fingerprint text not null default '',
  gclients integer not null default 1, xui_excluded text not null default '[]',
  client_host text
);
create table if not exists firewall_rule (
  id text primary key, server_id text not null references server(id) on delete cascade,
  port_from integer not null, port_to integer not null, proto text not null,
  source text not null default 'any', action text not null default 'allow',
  comment text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists backup (
  id text primary key, server_id text references server(id) on delete set null,
  server_name text not null default '', hostname text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  size integer not null default 0, sha256 text not null default '', manifest text not null default '{}'
);
create table if not exists access (
  id text primary key, server_id text not null references server(id) on delete cascade,
  kind text not null default 'custom', title text not null,
  fields text not null default '[]', note text not null default '',
  position integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists awg_client (
  server_id text not null references server(id) on delete cascade,
  container text not null, public_key text not null, private_key text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (server_id, container, public_key)
);
create table if not exists gclient (
  id text primary key, name text not null, note text not null default '',
  token text not null unique, xui_sub_id text not null default '', slug text not null unique,
  enabled integer not null default 1, access text, deleted_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists gclient_device (
  id text primary key, client_id text not null references gclient(id) on delete cascade,
  name text not null, type text not null default '', awg20 integer not null default 0,
  deleted_at text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists gclient_binding (
  id text primary key, client_id text not null references gclient(id) on delete cascade,
  device_id text, server_id text not null references server(id) on delete cascade,
  service text not null, ref text not null default '', secret text not null default '',
  links text not null default '[]', state text not null default 'pending',
  error text not null default '', xui_inbounds text,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists vless_cascade (
  id text primary key, entry_server_id text not null,
  entry_inbound_id integer, entry_port integer, entry_remark text not null default '',
  exit_server_id text not null,
  exit_inbound_id integer not null, mode text not null default 'ru-direct',
  direct_list text not null default '[]', exit_list text not null default '[]',
  block_quic integer not null default 0, check_result text, error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists gclient_ext (
  id text primary key, client_id text not null references gclient(id) on delete cascade,
  browser text not null default 'other', version text, enabled integer, server_id text,
  error text not null default '', seen_at text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists openflux_doc (
  id text primary key, kind text not null, url text not null unique,
  binding_id text references gclient_binding(id) on delete set null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists command_default (
  server_id text not null references server(id) on delete cascade,
  command_id text not null, answers text not null default '{}',
  primary key (server_id, command_id)
);
create table if not exists portsync_config (
  server_id text primary key references server(id) on delete cascade, config text not null
);
create table if not exists action_log (
  id text primary key, server_id text references server(id) on delete set null,
  kind text not null, params text not null default '{}',
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at text, exit_code integer, output text not null default '',
  initiator text not null default 'admin'
);
create index if not exists action_log_server on action_log(server_id, started_at);
create index if not exists action_log_started on action_log(started_at);
create table if not exists setting (key text primary key, value text not null);
`;
