import { type AgentRegistry, requireOnline } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import type { actionJournal } from './action-journal.js';
import type { EngineCatalog } from './mtproxyl-engine.js';
import { SECRET_OUTPUT_NOTE } from './mtproxyl-secrets.js';
import type { SecretBox } from './secret-box.js';
import type { UiHub } from './ui-hub.js';

/** Опции маршрутов действий над сервером (routes: firewall, docker, awg, mtproxyl, xui...). */
export interface ServerRouteOpts {
  db: Db;
  env: Env;
  registry: AgentRegistry;
  hub: UiHub;
  box: SecretBox;
  engines: EngineCatalog;
}

/**
 * Метод агента как действие в журнале: runStreamed - длинное, со стримом вывода в браузер (id
 * действия сразу), quickAction - короткое, результат сразу.
 */
export function actionRunners(registry: AgentRegistry, journal: ReturnType<typeof actionJournal>) {
  async function runStreamed(
    serverId: string,
    kind: string,
    method: Parameters<AgentRegistry['request']>[1],
    params: Record<string, unknown>,
    timeoutMs: number,
    /** Параметры для журнала, если в params есть секрет. */
    logParams: Record<string, unknown> = params,
  ) {
    requireOnline(registry, serverId);
    return journal.background(serverId, kind, logParams, async (action) => {
      await registry.request(serverId, method, params, { timeoutMs, onStream: action.stream });
    });
  }

  async function quickAction<T>(
    serverId: string,
    kind: string,
    method: Parameters<AgentRegistry['request']>[1],
    params: Record<string, unknown>,
    timeoutMs = 60_000,
    /** Вывод содержит секреты (ссылки MTProxyL с секретом): в журнал пишется только факт. */
    secretOutput = false,
    /** Параметры для журнала, если в params есть секрет. */
    logParams: Record<string, unknown> = params,
  ): Promise<T> {
    requireOnline(registry, serverId);
    return journal.quick(
      serverId,
      kind,
      logParams,
      () => registry.request<T>(serverId, method, params, { timeoutMs }),
      (res) =>
        secretOutput
          ? SECRET_OUTPUT_NOTE
          : typeof res === 'object' && res && 'output' in res
            ? String((res as { output: unknown }).output)
            : '',
    );
  }

  return { runStreamed, quickAction };
}
