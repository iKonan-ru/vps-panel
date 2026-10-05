import type { ServerStatus } from './server.js';

/** Матрица "серверы x сервисы" по эталону (раздел "Сервисы"): ответ /api/standard. */
export type StdKey = 'xui' | 'mtproxyl' | 'awg-3.1' | 'awg-2.0' | 'wdtt' | 'openflux' | 'naive';

/**
 * Клетка матрицы. ok - как в эталоне; warn - есть, но с отклонением (обновление, нет своих
 * inbound-ов); missing - нет, можно поставить; unknown - нет данных; na - панель пока не
 * отслеживает.
 */
export interface StdCell {
  state: 'ok' | 'warn' | 'missing' | 'unknown' | 'na';
  text: string;
  hint?: string;
}

export interface StdItem {
  key: StdKey;
  title: string;
  install?: string;
  installHint?: string;
}

export interface StdRow {
  serverId: string;
  name: string;
  status: ServerStatus;
  cells: Record<StdKey, StdCell>;
}

export interface StdMatrix {
  standard: StdItem[];
  rows: StdRow[];
}
