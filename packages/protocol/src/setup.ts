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
  | 'reach';

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

export type SetupMode = 'keep' | 'reinstall' | 'skip';

/** Ход последнего запуска настройки сервера. */
export interface SetupProgress {
  actionId: string;
  /** Запуск с восстановлением из этой копии. */
  backupId?: string | undefined;
  startedAt: string;
  finishedAt: string | null;
  /** Шаги запуска с состоянием; note - итог или причина ошибки. */
  steps: { id: string; title: string; state: SetupStepState; note?: string }[];
}

export interface SetupPlan {
  steps: SetupStep[];
  progress: SetupProgress | null;
  /** План восстановления: копия, с какого сервера и когда. */
  backup?: { id: string; serverName: string; createdAt: string };
}

/** Запуск: отмеченные шаги с ответами; from - продолжить с этого шага (сделанное пропускается). */
export interface SetupRunRequest {
  /** Восстановить из копии: сервисы - как были на старом сервере, затем данные архива. */
  backupId?: string | undefined;
  steps: { id: string; enabled: boolean; answers?: Record<string, string> | undefined }[];
  from?: string | undefined;
}

export interface SetupCheck {
  step: string;
  level: 'ok' | 'warn' | 'fail';
  text: string;
}
