import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

/** Доступность из России (lib/ru-reach.ts на сервере). */
export interface ReachTarget {
  key: string;
  title: string;
  kind: 'tcp' | 'tls';
  port: number;
  sni?: string;
  percent: number | null;
  total: number;
  ok: number;
  errors: string[];
  error?: string;
  checkedAt: string | null;
  history: { at: string; percent: number; total: number }[];
  source: 'agent' | 'mtproxyl';
}

export interface ServerReach {
  checkedAt: string | null;
  error?: string;
  remaining?: number;
  targets: ReachTarget[];
}

export type ReachLevel = 'ok' | 'partial' | 'bad';

/** Как у MTProxyL: от 80% - видно, от 50% - частично, ниже - не видно. */
export function reachLevel(percent: number | null): ReachLevel | null {
  if (percent === null) return null;
  return percent >= 80 ? 'ok' : percent >= 50 ? 'partial' : 'bad';
}

export const reachTone = { ok: 'ok', partial: 'warn', bad: 'bad' } as const;

/** Итоги по всем серверам: одна выборка на страницу серверов. */
export function useReachAll() {
  return useQuery({
    queryKey: ['reach'],
    queryFn: () => api<Record<string, ServerReach>>('/api/reach'),
    refetchInterval: 5 * 60_000,
  });
}

export function useServerReach(serverId: string) {
  return useQuery({
    queryKey: ['reach', serverId],
    queryFn: () => api<ServerReach | null>(`/api/servers/${serverId}/reach`),
    refetchInterval: 5 * 60_000,
  });
}
