import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { ServiceUpdateKind } from '@vps/protocol';
import { useSyncExternalStore } from 'react';
import { api } from './api';

const mtExec = (id: string, op: string) =>
  api<{ actionId: string }>(`/api/servers/${id}/mtproxyl/exec`, {
    method: 'POST',
    json: { op, args: {} },
  });

/** Запуск обновления сервиса, общий для Обзора и вкладок 3X-UI и MTProxyL; xray - ядро 3X-UI. */
export const startServiceUpdate: Record<
  ServiceUpdateKind,
  (serverId: string) => Promise<{ actionId: string }>
> = {
  xui: (id) => api(`/api/servers/${id}/xui/update`, { method: 'POST' }),
  xray: (id) => api(`/api/servers/${id}/xray/update`, { method: 'POST' }),
  mtproxyl: (id) => mtExec(id, 'update'),
  'mtproxyl-panel': (id) => mtExec(id, 'panel.update'),
};

/** Действия-обновления сервиса: по их окончании версии перепроверяются. */
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
// по серверу: проверку видят все блоки с версиями - и запущенную кнопкой, и после обновления
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
 * Проверка обновлений сервера: панель сверяет версии сервисов с релизами, затем версии
 * перечитываются во всех блоках. Повтор во время проверки не запускается.
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
  // конец проверки - только после перечитывания версий: иначе "Обновить" оживёт на старых данных
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
