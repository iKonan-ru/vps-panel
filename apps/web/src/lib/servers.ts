import { useQuery } from '@tanstack/react-query';
import { type ServerDetail, type ServerSummary, isBlockingAction } from '@vps/protocol';
import { api } from './api';

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api<ServerSummary[]>('/api/servers'),
    refetchInterval: 60_000,
  });
}

/** Занят ли сервер блокирующим действием; reason - подсказка для неактивных кнопок. */
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
