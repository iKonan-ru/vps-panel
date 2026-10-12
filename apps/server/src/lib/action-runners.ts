import type { AgentRegistry } from '../agents/registry.js';
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
 * Запуск метода агента как действия в журнале: runStreamed - длинное, со стримом вывода в
 * браузер (id действия сразу), quickAction - короткое, результат сразу (ошибка агента - с кодом
 * реестра, иначе 502).
 */
export function actionRunners(registry: AgentRegistry, journal: ReturnType<typeof actionJournal>) {
  /** Запускает метод агента как действие со стримом. Возвращает id действия сразу. */
  async function runStreamed(
    serverId: string,
    kind: string,
    method: Parameters<AgentRegistry['request']>[1],
    params: Record<string, unknown>,
    timeoutMs: number,
    /** Параметры для журнала, если в params есть секрет. */
    logParams: Record<string, unknown> = params,
  ) {
    if (!registry.isOnline(serverId))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    const action = journal.open(serverId, kind, logParams);
    registry
      .request(serverId, method, params, { timeoutMs, onStream: action.stream })
      .then(() => action.finish(0))
      .catch((e: Error) => {
        action.stream('log', `\nОШИБКА: ${e.message}\n`);
        void action.finish(1);
      });
    return action.id;
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
    if (!registry.isOnline(serverId))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    const actionId = await journal.start(serverId, kind, logParams);
    try {
      const res = await registry.request<T>(serverId, method, params, { timeoutMs });
      await journal.finish(
        actionId,
        serverId,
        0,
        secretOutput
          ? SECRET_OUTPUT_NOTE
          : typeof res === 'object' && res && 'output' in res
            ? String((res as { output: unknown }).output)
            : '',
      );
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await journal.finish(actionId, serverId, 1, msg);
      // Ошибка агента - это ответ для человека, а не сбой панели: текст с кодом реестра (агент
      // устарел - 409, не ответил - 504), прочее - 502.
      const code = (e as { statusCode?: unknown }).statusCode;
      throw Object.assign(new Error(msg), { statusCode: typeof code === 'number' ? code : 502 });
    }
  }

  return { runStreamed, quickAction };
}
