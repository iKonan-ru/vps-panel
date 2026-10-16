import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type ParamType =
  | 'string'
  | 'password'
  | 'number'
  | 'port'
  | 'select'
  | 'bool'
  | 'text'
  | 'domain'
  | 'awg-container';

export interface CommandParam {
  name: string;
  label: string;
  type: ParamType;
  default?: string;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  pattern?: string;
  min?: number;
  max?: number;
  secret?: boolean;
  showIf?: Record<string, string>;
}

export interface CommandInfo {
  id: string;
  title: string;
  group: 'install' | 'maintain';
  /** Сервис: команды одного сервиса показываются одной карточкой. */
  service?: string;
  description: string;
  params: CommandParam[];
  hasPreflight: boolean;
  after?: string;
}

export interface CommandRun {
  id: string;
  serverId: string | null;
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface Check {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export const commandsApi = {
  list: () => api<CommandInfo[]>('/api/commands'),
  runs: () => api<CommandRun[]>('/api/commands/runs'),
  defaults: (serverId: string, cmd: string) =>
    api<Record<string, string>>(`/api/servers/${serverId}/commands/${cmd}/defaults`),
  plan: (serverId: string, cmd: string, answers: Record<string, string>) =>
    api<{ steps: string[]; errors: string[] }>(`/api/servers/${serverId}/commands/${cmd}/plan`, {
      method: 'POST',
      json: answers,
    }),
  preflight: (serverId: string, cmd: string, answers: Record<string, string>) =>
    api<{ checks: Check[]; canRun: boolean }>(
      `/api/servers/${serverId}/commands/${cmd}/preflight`,
      { method: 'POST', json: answers },
    ),
  run: (serverId: string, cmd: string, answers: Record<string, string>) =>
    api<{ actionId: string }>(`/api/servers/${serverId}/commands/${cmd}/run`, {
      method: 'POST',
      json: answers,
    }),
  cancel: (actionId: string) =>
    api<{ cancelled: boolean }>(`/api/actions/${actionId}/cancel`, { method: 'POST' }),
};

export function useCommands() {
  return useQuery({ queryKey: ['commands'], queryFn: commandsApi.list, staleTime: 5 * 60_000 });
}

export const groupTitles: Record<CommandInfo['group'], string> = {
  install: 'Установка сервисов',
  maintain: 'Обслуживание',
};

export function paramVisible(p: CommandParam, answers: Record<string, string>): boolean {
  if (!p.showIf) return true;
  return Object.entries(p.showIf).every(([k, v]) => answers[k] === v);
}
