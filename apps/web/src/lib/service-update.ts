import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from './api';

export type ServiceUpdateKind = 'xui' | 'xray' | 'mtproxyl' | 'mtproxyl-panel';

const mtExec = (id: string, op: string) =>
  api<{ actionId: string }>(`/api/servers/${id}/mtproxyl/exec`, {
    method: 'POST',
    json: { op, args: {} },
  });

/** Запуск обновления сервиса: одно и то же из Обзора и со вкладок 3X-UI и MTProxyL. Xray - ядро внутри 3X-UI. */
export const startServiceUpdate: Record<
  ServiceUpdateKind,
  (serverId: string) => Promise<{ actionId: string }>
> = {
  xui: (id) => api(`/api/servers/${id}/xui/update`, { method: 'POST' }),
  xray: (id) => api(`/api/servers/${id}/xray/update`, { method: 'POST' }),
  mtproxyl: (id) => mtExec(id, 'update'),
  'mtproxyl-panel': (id) => mtExec(id, 'panel.update'),
};

/** Действия-обновления сервиса: по их окончании версии перепроверяются (lib/live.ts). */
export const SERVICE_UPDATE_ACTIONS = new Set([
  'xui:update',
  'xui:xray',
  'mtproxyl:update',
  'mtproxyl:panel.update',
]);

interface CheckState {
  checking: boolean;
  error: string | null;
}
const IDLE: CheckState = { checking: false, error: null };
// по серверу: проверку видят все блоки с версиями, и запущенную кнопкой, и после обновления
const checks = new Map<string, CheckState>();
const listeners = new Set<() => void>();
function setCheck(serverId: string, st: CheckState) {
  checks.set(serverId, st);
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * Проверка обновлений сервера: панель сверяет версии сервисов с релизами, затем свежие версии -
 * во вкладках сервисов, в "Обзоре" и в списке серверов. Повтор во время проверки не запускается.
 */
export async function checkUpdates(qc: QueryClient, serverId: string): Promise<void> {
  if (checks.get(serverId)?.checking) return;
  setCheck(serverId, { checking: true, error: null });
  let error: string | null = null;
  try {
    await api(`/api/servers/${serverId}/updates/check`, { method: 'POST' });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // проверка закончена - только со свежими версиями: иначе "Обновить" по старым данным
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['xui-versions', serverId] }),
    qc.invalidateQueries({ queryKey: ['mtproxyl-versions', serverId] }),
    qc.invalidateQueries({ queryKey: ['service-updates', serverId] }),
    qc.invalidateQueries({ queryKey: ['service-updates-all'] }),
  ]);
  setCheck(serverId, { checking: false, error });
}

/** Идёт ли проверка обновлений сервера, её ошибка и запуск кнопкой. */
export function useUpdatesCheck(serverId: string) {
  const qc = useQueryClient();
  const st = useSyncExternalStore(subscribe, () => checks.get(serverId) ?? IDLE);
  return { checking: st.checking, error: st.error, check: () => checkUpdates(qc, serverId) };
}
