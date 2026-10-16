/**
 * Настройка сервера в один клик: шаги по порядку. Шаг сервиса - команда каталога с ответами,
 * у остальных свои поля (answers): inbounds - RAW_PORT, XHTTP_PORT, RAW, XHTTP ("1"/"");
 * client-host - NAME.
 */
export type SetupStepKind =
  | 'key'
  | 'baseline'
  | 'upgrade'
  | 'client-host'
  | 'service'
  | 'inbounds'
  | 'restore'
  | 'gclients'
  | 'reboot'
  | 'reach'
  /** Очистка: удалить наши сервисы, что уже стоят (перед установкой из копии). */
  | 'wipe'
  /** Перенос: свежая копия старого сервера в момент переноса. */
  | 'snapshot'
  /** Перенос: клиенты, доступы и настройки старого сервера - этому. */
  | 'migrate'
  /** Перенос: что сделать со старым сервером (answers.MODE: remove, delete, keep). */
  | 'retire';

export type SetupStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SetupStep {
  id: string;
  kind: SetupStepKind;
  title: string;
  /** Команда каталога шага сервиса. */
  command?: string;
  enabled: boolean;
  /** Почему шаг выключен или что учесть (сервис уже стоит, нет 3X-UI). */
  note?: string;
  /** Ответы команды (без паролей - их вводят на экране) или поля шага. */
  answers?: Record<string, string>;
  /** Шаг нельзя выключить (контейнер AWG из копии). */
  locked?: boolean;
  /** Данные сервиса придут из копии: паролей не спрашивают, их заменит архив. */
  fromBackup?: boolean;
  /**
   * Сервис (контейнер AWG) уже стоит на сервере: вместо галочки - выбор answers.MODE из modes.
   * keep - оставить, данные заменит копия; reinstall - удалить и поставить заново; skip - не
   * трогать (данные этого сервиса из копии не раскладываются).
   */
  modes?: SetupMode[];
}

/**
 * keep, reinstall, skip - уже стоящий сервис; у шага retire (старый сервер после переноса):
 * remove - снять сервисы и агента, удалить из панели; delete - только удалить из панели;
 * keep - оставить в панели без клиентов.
 */
export type SetupMode = 'keep' | 'reinstall' | 'skip' | 'remove' | 'delete';

/**
 * Откуда настройка: пустой сервер (ничего), копия этого же сервера (backupId) или перенос с
 * другого сервера панели (migrateFrom: его копия backupId, без неё - свежая копия при переносе).
 * wipe - удалить наши сервисы, что уже стоят, и ставить как на пустой.
 */
export interface SetupSource {
  backupId?: string | undefined;
  migrateFrom?: string | undefined;
  wipe?: boolean | undefined;
}

/** Ход последнего запуска настройки сервера. */
export interface SetupProgress {
  actionId: string;
  /** Запуск с восстановлением из этой копии (при переносе со свежей копией - когда она снята). */
  backupId?: string | undefined;
  /** Перенос: с какого сервера; очистка - была ли выбрана (для продолжения). */
  migrateFrom?: string | undefined;
  wipe?: boolean | undefined;
  startedAt: string;
  finishedAt: string | null;
  /** Шаги запуска с состоянием; note - итог или причина ошибки. */
  steps: { id: string; title: string; state: SetupStepState; note?: string }[];
}

export interface SetupPlan {
  steps: SetupStep[];
  progress: SetupProgress | null;
  /** План восстановления: копия, с какого сервера и когда (свежая при переносе - без id). */
  backup?: { id: string; serverName: string; createdAt: string };
  /** План переноса: старый сервер. */
  migrate?: { id: string; name: string; online: boolean };
  /** Что из наших сервисов уже стоит на сервере (для галочки очистки). */
  installed?: string[];
}

/** Запуск: отмеченные шаги с ответами; from - продолжить с этого шага (сделанное пропускается). */
export interface SetupRunRequest extends SetupSource {
  steps: { id: string; enabled: boolean; answers?: Record<string, string> | undefined }[];
  from?: string | undefined;
}

export interface SetupCheck {
  step: string;
  level: 'ok' | 'warn' | 'fail';
  text: string;
}
