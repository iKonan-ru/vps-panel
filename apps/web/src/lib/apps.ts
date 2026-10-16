import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import type { AppView } from '@vps/protocol';

export interface AppsList {
  checkedAt: string | null;
  apps: AppView[];
}

/** Клиентские приложения со ссылками по ОС (релизы GitHub проверяются раз в 6 часов). */
export function useApps() {
  return useQuery({
    queryKey: ['apps'],
    queryFn: () => api<AppsList>('/api/apps'),
    staleTime: 10 * 60_000,
  });
}
