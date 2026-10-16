import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import type { AppView } from '@vps/protocol';

export interface AppsList {
  checkedAt: string | null;
  apps: AppView[];
}

/** Клиентские приложения со ссылками на загрузку по ОС. */
export function useApps() {
  return useQuery({
    queryKey: ['apps'],
    queryFn: () => api<AppsList>('/api/apps'),
    staleTime: 10 * 60_000,
  });
}
