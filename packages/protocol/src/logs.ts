/**
 * Журнал серверов (отдельная база logs.db): разделы, у каждого свой срок хранения.
 * agent - связь агента с панелью; reach - проверки доступности из России по зондам; conn -
 * сеансы подключений адресов к сервисам; action - действия панели на сервере и их итог; server -
 * изменения на сервере по снимкам агента (службы, контейнеры, порты, баны fail2ban,
 * перезагрузки, системный журнал: входы SSH, OOM, падения служб); dest - назначения клиентов xray
 * по часам (журнал доступа xray); metric - нагрузка по минутам (старше недели - по часам).
 */
export const LOG_CATEGORIES = [
  'agent',
  'reach',
  'conn',
  'dest',
  'action',
  'server',
  'metric',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const LOG_CATEGORY_TITLES: Record<LogCategory, string> = {
  agent: 'Связь с агентом',
  reach: 'Доступность из России',
  conn: 'Подключения',
  dest: 'Назначения',
  action: 'Действия',
  server: 'Изменения на сервере',
  metric: 'Нагрузка',
};

export interface LogSettings {
  enabled: boolean;
  /** Срок хранения раздела, дней. */
  days: Record<LogCategory, number>;
  /** Предел размера базы журнала, МБ: сверх него удаляются самые старые записи. */
  maxMb: number;
}

export const LOG_DEFAULTS: LogSettings = {
  enabled: true,
  days: { agent: 365, reach: 365, conn: 60, dest: 30, action: 365, server: 365, metric: 90 },
  maxMb: 1024,
};

export const LOG_DAYS_MAX = 3650;
export const LOG_MB_MIN = 50;
export const LOG_MB_MAX = 100_000;

export interface LogStats {
  /** Размер файлов базы журнала, байт. */
  bytes: number;
  categories: Record<LogCategory, { rows: number; oldest: string | null }>;
  servers: { id: string; name: string; rows: number }[];
}

/** Журнал доступа xray сервера: из него берутся назначения клиентов. */
export interface LogAccessState {
  serverId: string;
  name: string;
  /** null - агент ещё не сообщил (не в сети или старый). */
  enabled: boolean | null;
  path?: string;
  error?: string;
  online: boolean;
  /** Агент забирает журнал сервера (events.pull); не в сети - false. */
  agent: boolean;
}

export interface LogsView {
  settings: LogSettings;
  stats: LogStats;
  /** Серверы с 3X-UI. */
  access: LogAccessState[];
}

/** Событие буфера агента (events.pull). */
export interface AgentLogEvent {
  seq: number;
  at: string;
  kind: string;
  level: string;
  text?: string;
  ip?: string;
  data?: unknown;
}

/** Ответ агента events.pull. */
export interface AgentLogPull {
  epoch: string;
  events: AgentLogEvent[];
  /** Потеряно событий из-за переполнения буфера агента. */
  dropped: number;
  more: boolean;
  access: { enabled: boolean; path?: string; error?: string };
}

/** Что выгрузить или удалить: пусто - всё. */
export interface LogFilter {
  servers?: string[];
  categories?: LogCategory[];
  /** ISO, включительно. */
  from?: string;
  /** ISO, не включительно. */
  to?: string;
  clientId?: string;
  ip?: string;
}
