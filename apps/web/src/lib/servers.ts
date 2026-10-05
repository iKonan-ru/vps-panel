import { useQuery } from '@tanstack/react-query';
import { type ServerSummary, isBlockingAction } from '@vps/protocol';
import { api } from './api';

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api<ServerSummary[]>('/api/servers'),
    refetchInterval: 60_000,
  });
}

export interface ServerDetail extends ServerSummary {
  inventory: import('@vps/protocol').Inventory | null;
  metricsAt: string | null;
  /** Незавершённые действия на этом сервере (чтобы после перезагрузки страницы видеть их ход). */
  activeActions: { id: string; kind: string; title: string; startedAt: string }[];
}

/**
 * Занят ли сервер действием (установка, обновление, исправление...): пока оно идёт, другие
 * изменения на сервере недоступны. reason - подсказка для неактивных кнопок.
 */
export function serverLock(s: ServerDetail): { busy: boolean; reason: string | undefined } {
  const a = s.activeActions.find((x) => isBlockingAction(x.kind));
  return a ? { busy: true, reason: `Идёт: ${a.title}` } : { busy: false, reason: undefined };
}

export function useServer(id: string) {
  return useQuery({
    queryKey: ['servers', id],
    queryFn: () => api<ServerDetail>(`/api/servers/${id}`),
    enabled: Boolean(id),
  });
}
