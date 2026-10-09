import { api } from './api';

export type ServiceUpdateKind = 'xui' | 'mtproxyl' | 'mtproxyl-panel';

const mtExec = (id: string, op: string) =>
  api<{ actionId: string }>(`/api/servers/${id}/mtproxyl/exec`, {
    method: 'POST',
    json: { op, args: {} },
  });

/** Запуск обновления сервиса: одно и то же из Обзора и со вкладок 3X-UI и MTProxyL. */
export const startServiceUpdate: Record<
  ServiceUpdateKind,
  (serverId: string) => Promise<{ actionId: string }>
> = {
  xui: (id) => api(`/api/servers/${id}/xui/update`, { method: 'POST' }),
  mtproxyl: (id) => mtExec(id, 'update'),
  'mtproxyl-panel': (id) => mtExec(id, 'panel.update'),
};
