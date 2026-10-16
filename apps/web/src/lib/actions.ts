import {
  type ActionListRow,
  type BaselinePlan,
  type PortsyncConfig,
  type RuleInput,
  actionTitle,
} from '@vps/protocol';
import { api } from './api';

/** Обёртки над маршрутами действий панели. */
export const actions = {
  baselinePlan: (id: string) =>
    api<BaselinePlan>(`/api/servers/${id}/baseline/plan`, { method: 'POST' }),
  baselineApply: (id: string, steps: string[]) =>
    api<{ actionId: string }>(`/api/servers/${id}/baseline/apply`, {
      method: 'POST',
      json: { steps },
    }),
  firewallEnable: (id: string) =>
    api<{ actionId: string }>(`/api/servers/${id}/firewall/enable`, { method: 'POST' }),
  firewallDisable: (id: string, restartDocker: boolean) =>
    api<{ actionId: string }>(`/api/servers/${id}/firewall/disable`, {
      method: 'POST',
      json: { restartDocker },
    }),
  portsyncRun: (id: string) =>
    api<{ ok: boolean; output: string }>(`/api/servers/${id}/firewall/portsync/run`, {
      method: 'POST',
    }),
  portsyncGet: (id: string) => api<PortsyncConfig>(`/api/servers/${id}/firewall/portsync`),
  portsyncPut: (id: string, config: PortsyncConfig) =>
    api<unknown>(`/api/servers/${id}/firewall/portsync`, { method: 'PUT', json: config }),
  ruleAdd: (id: string, rule: RuleInput) =>
    api<{ id: string }>(`/api/servers/${id}/firewall/rules`, { method: 'POST', json: rule }),
  ruleDelete: (id: string, rid: string) =>
    api<{ ok: boolean }>(`/api/servers/${id}/firewall/rules/${rid}`, { method: 'DELETE' }),
  docker: (id: string, cid: string, action: 'start' | 'stop' | 'restart' | 'remove') =>
    api<{ ok: boolean }>(`/api/servers/${id}/docker/${cid}/${action}`, { method: 'POST' }),
  dockerLogs: (id: string, cid: string, tail = 500) =>
    api<{ text: string }>(`/api/servers/${id}/docker/${cid}/logs?tail=${tail}`),
  agentUpdate: (id: string) =>
    api<{ actionId: string }>(`/api/servers/${id}/agent/update`, { method: 'POST' }),
  agentUpdateCancel: (id: string) =>
    api<{ cancelled: boolean }>(`/api/servers/${id}/agent/update/cancel`, { method: 'POST' }),
  upgrade: (id: string) =>
    api<{ actionId: string }>(`/api/servers/${id}/upgrade`, { method: 'POST' }),
  sshKeysAdd: (id: string, keys: string[], panelKey: boolean) =>
    api<{ added: number }>(`/api/servers/${id}/ssh-keys`, {
      method: 'POST',
      json: { keys, panelKey },
    }),
  sshKeysRemove: (id: string, fingerprint: string) =>
    api<{ ok: boolean }>(`/api/servers/${id}/ssh-keys/remove`, {
      method: 'POST',
      json: { fingerprint },
    }),
  sshKeysComment: (id: string, fingerprint: string, comment: string) =>
    api<{ ok: boolean }>(`/api/servers/${id}/ssh-keys/comment`, {
      method: 'POST',
      json: { fingerprint, comment },
    }),
  reboot: (id: string, confirmName: string) =>
    api<{ ok: boolean }>(`/api/servers/${id}/reboot`, { method: 'POST', json: { confirmName } }),
  log: (id: string) => api<ActionRow[]>(`/api/servers/${id}/actions`),
  patchServer: (id: string, patch: unknown) =>
    api<{ ok: boolean }>(`/api/servers/${id}`, { method: 'PATCH', json: patch }),
  deleteServer: (id: string) => api<{ ok: boolean }>(`/api/servers/${id}`, { method: 'DELETE' }),
  registration: (id: string) =>
    api<{ installCommand: string }>(`/api/servers/${id}/registration`, { method: 'POST' }),
};

/** Строка журнала (тип - общий с сервером). */
export type ActionRow = ActionListRow;

export { actionTitles } from '@vps/protocol';

/** Название действия для журнала: у команд каталога - их название (а не command:id). */
export function actionName(r: { kind: string; params: Record<string, unknown> }): string {
  const t = actionTitle(r.kind, r.params);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
