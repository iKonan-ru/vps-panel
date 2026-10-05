import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

export type AppOs = 'android' | 'ios' | 'windows' | 'macos' | 'linux';
export interface AppLink {
  label: string;
  url: string;
  version?: string;
  note?: string;
}
export interface AppView {
  id: string;
  name: string;
  purpose: string;
  platforms: { os: AppOs; title: string; links: AppLink[] }[];
}
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
