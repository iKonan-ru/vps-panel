/**
 * Описание команды каталога. Команда - bash-скрипт, который агент выполняет
 * с ответами на вопросы в переменных окружения. Секреты в командную строку не
 * попадают и в журнале не сохраняются.
 */
export type ParamType =
  | 'string'
  | 'password'
  | 'number'
  | 'port'
  | 'select'
  | 'bool'
  | 'text'
  | 'domain'
  /** Контейнер AWG, который есть на выбранном сервере (список строит форма по инвентарю). */
  | 'awg-container';

export interface CommandParam {
  /** Имя переменной окружения в скрипте. */
  name: string;
  label: string;
  type: ParamType;
  default?: string;
  /** Генерирует значение по умолчанию при открытии формы (случайный порт, путь, пароль). */
  generate?: () => string;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Регулярное выражение для проверки (строка, чтобы отдать в браузер). */
  pattern?: string;
  min?: number;
  max?: number;
  /** Секрет: не запоминается как значение по умолчанию и не пишется в журнал. */
  secret?: boolean;
  /** Показывать только при таком значении другого параметра: { name: value }. */
  showIf?: Record<string, string>;
}

export interface RunContext {
  panelUrl: string;
  server: { id: string; name: string; host: string; clientHost?: string | null };
  answers: Record<string, string>;
}

export interface CommandDef {
  id: string;
  title: string;
  group: 'install' | 'maintain';
  /**
   * Сервис, к которому относится команда: на странице команды одного сервиса собраны
   * в одну карточку, install-команда - кнопка "Установить", maintain - "Удалить".
   */
  service?: string;
  description: string;
  params: CommandParam[];
  timeoutSec: number;
  /** Скрипт bash; ответы доступны как $ИМЯ, плюс PANEL_URL, SERVER_HOST, SERVER_NAME. */
  script: string;
  /**
   * Значения формы, которые зависят от текущего состояния (свободный порт, подсеть): считаются
   * при открытии формы и перекрывают сохранённые ответы прошлого запуска на этом сервере.
   */
  liveDefaults?: 'awg' | 'naive' | 'mtproxyl';
  /** Дополнительные переменные, вычисленные из ответов (например, сгенерированные ключи). */
  env?: (ctx: RunContext) => Record<string, string>;
  /** Файлы, которые нужно положить до запуска (секреты через файлы). */
  files?: (ctx: RunContext) => Record<string, string>;
  /** Файлы, удаляемые после завершения. */
  cleanup?: string[];
  /** Скрипт быстрых проверок; печатает строки "OK|текст", "WARN|текст", "FAIL|текст". */
  preflight?: string;
  /** "Что будет сделано" для формы. */
  plan: (answers: Record<string, string>) => string[];
  /** Подсказка после успешного завершения. */
  after?: string;
  /**
   * Сервисы, чьи привязки глобальных клиентов на этом сервере после успешного запуска уходят в
   * сверку (ссылки на личных страницах перевыпускаются).
   */
  resync?: string[];
  /**
   * Сервисы, привязки глобальных клиентов к которым на этом сервере после успешного запуска
   * удаляются сразу: сервис снесён вместе с пользователями (без этого сверка ждёт 30 минут
   * отсутствия сервиса в снимках, а привязка висит "ждёт сверки").
   */
  dropsBindings?: string[];
  /**
   * Только привязки, ref которых содержит эту строку (AWG: "|<контейнер>|" - удаляется один
   * экземпляр, привязки к остальным остаются, иначе сверка завела бы людям новые ключи).
   */
  dropsBindingsRef?: (answers: Record<string, string>) => string;
  /**
   * Параметр с именем, на которое на сервере панели сертификат выпускает Caddy панели
   * (lib/panel-certs.ts): панель разрешает его на время проверок и запуска.
   */
  panelCertParam?: string;
  /**
   * Доступы после успешного выполнения (логин, пароль, ссылка на панель...):
   * панель сохраняет их в "Доступах" сервера. output - полный вывод команды.
   */
  access?: (ctx: RunContext & { output: string }) => AccessEntry | AccessEntry[] | null;
  /** Доступы этих видов после успешного выполнения устаревают (сервис поставлен заново) - удаляются. */
  forgetsAccess?: string[];
}

export interface AccessEntry {
  kind: string;
  title: string;
  fields: { label: string; value: string; secret?: boolean }[];
  note?: string;
}

/** Описание для интерфейса: без скриптов и функций. */
export interface CommandInfo {
  id: string;
  title: string;
  group: CommandDef['group'];
  service?: string;
  description: string;
  params: Omit<CommandParam, 'generate'>[];
  hasPreflight: boolean;
  after?: string;
}

export function toInfo(c: CommandDef): CommandInfo {
  const info: CommandInfo = {
    id: c.id,
    title: c.title,
    group: c.group,
    description: c.description,
    params: c.params.map(({ generate: _g, ...rest }) => rest),
    hasPreflight: Boolean(c.preflight),
  };
  if (c.service) info.service = c.service;
  if (c.after) info.after = c.after;
  return info;
}
