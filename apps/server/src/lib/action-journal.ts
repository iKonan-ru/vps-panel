import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { beginAction } from './action-lock.js';
import { newId } from './ids.js';
import type { UiHub } from './ui-hub.js';

/** Вывод действия в журнале - хвост этой длины; столько же держим в памяти, пока оно идёт. */
export const MAX_OUTPUT = 1_000_000;

/**
 * Вывод идущих действий (в базе он появляется только по окончании): консоль, открытая посреди
 * действия, получает уже выведенное, а не пустое "ожидание вывода".
 */
const running = new Map<string, () => string>();

/** Вид идущих действий: подписчики окончания узнают, что закончилось. */
const kinds = new Map<string, string>();

/**
 * Окончание действия: сервер, вид действия и запрошенный после него свежий снимок (resolve -
 * снимок пришёл или не удался).
 */
type FinishedListener = (serverId: string, kind: string, fresh: Promise<void>) => void;

/** Кто ждёт окончания действий на серверах (синхронизация клиентов, пропустившая занятый). */
const finishedListeners = new Set<FinishedListener>();

/** Подписка на окончание любого действия; возвращает отписку. */
export function onActionFinished(fn: FinishedListener): () => void {
  finishedListeners.add(fn);
  return () => {
    finishedListeners.delete(fn);
  };
}

/** Действие на сервере закончилось: сказать подписчикам. */
export function actionFinished(
  serverId: string,
  kind = '',
  fresh: Promise<void> = Promise.resolve(),
) {
  for (const fn of finishedListeners) fn(serverId, kind, fresh);
}

/** Накопленный вывод идущего действия или null (не идёт или без стрима). */
export function liveOutput(id: string): string | null {
  return running.get(id)?.() ?? null;
}

/** Действие со стримом вывода (journal.open). */
export interface Action {
  id: string;
  /** Кусок вывода: в браузер сразу, в память - хвост (действия идут до 50 минут). */
  stream: (channel: string, chunk: string) => void;
  /** Накопленный вывод (последние MAX_OUTPUT символов). */
  readonly output: string;
  /** Итог; text - что записать в журнал вместо вывода (вывод с секретами). */
  finish: (exitCode: number, text?: string) => Promise<void>;
}

/**
 * Цикл действия на сервере: запись в журнале (с блокировкой сервера - action-lock), события
 * в браузер, по окончании - итог и свежий inventory. Общий для маршрутов и фоновых задач
 * (сверка глобальных клиентов).
 */
export function actionJournal(db: Db, hub: UiHub, registry: AgentRegistry) {
  async function finish(id: string, serverId: string, exitCode: number, output: string) {
    running.delete(id);
    const kind = kinds.get(id) ?? '';
    kinds.delete(id);
    await db
      .update(actionLog)
      .set({ finishedAt: new Date().toISOString(), exitCode, output: output.slice(-MAX_OUTPUT) })
      .where(eq(actionLog.id, id));
    hub.broadcast({ type: 'action.finished', serverId, actionId: id, exitCode });
    // после любого действия просим агента прислать свежий inventory: интерфейс обновится сам
    actionFinished(serverId, kind, registry.refreshInventory(serverId));
  }

  /**
   * Начать действие со стримом. Сервер занят другим - исключение 409; force - без проверки
   * (переустановка агента: ею чинят зависшего).
   */
  function open(
    serverId: string,
    kind: string,
    params: Record<string, unknown> = {},
    force = false,
  ): Action {
    const id = newId();
    beginAction(db, { id, serverId, kind, params }, force);
    kinds.set(id, kind);
    hub.broadcast({ type: 'action.started', serverId, actionId: id, kind });
    let output = '';
    running.set(id, () => output);
    return {
      id,
      get output() {
        return output;
      },
      stream(channel, chunk) {
        output += chunk;
        // обрезка изредка, а не на каждый кусок: держим не больше двух хвостов
        if (output.length > 2 * MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
        hub.broadcast({ type: 'action.stream', serverId, actionId: id, channel, chunk });
      },
      finish: (exitCode, text) => finish(id, serverId, exitCode, text ?? output),
    };
  }

  /**
   * Короткое действие: результат fn - сразу, log(результат) - итог в журнал. Ошибка - в журнал
   * с кодом 1 и дальше со своим statusCode (без него - 502: это ответ сервиса, не сбой панели).
   */
  async function quick<T>(
    serverId: string,
    kind: string,
    params: Record<string, unknown>,
    fn: () => Promise<T>,
    log: (r: T) => string = () => '',
  ): Promise<T> {
    const id = open(serverId, kind, params).id;
    try {
      const r = await fn();
      await finish(id, serverId, 0, log(r));
      return r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finish(id, serverId, 1, message);
      const code = (e as { statusCode?: unknown }).statusCode;
      throw Object.assign(new Error(message), {
        statusCode: typeof code === 'number' ? code : 502,
        ...((e as { code?: unknown }).code ? { code: (e as { code: unknown }).code } : {}),
      });
    }
  }

  /**
   * Длинное действие со стримом: id сразу, fn - в фоне; fn вернула число - это код итога. fn
   * бросила - текст ошибки в вывод и код 1. after - когда действие закрыто и сервер свободен (синхронизация после него не пропустит
   * сервер как занятый).
   */
  function background(
    serverId: string,
    kind: string,
    params: Record<string, unknown>,
    fn: (action: Action) => Promise<unknown>,
    opts: { after?: (ok: boolean) => void; force?: boolean } = {},
  ): string {
    const action = open(serverId, kind, params, opts.force);
    void (async () => {
      let code = 0;
      try {
        const r = await fn(action);
        code = typeof r === 'number' ? r : 0;
      } catch (e) {
        code = 1;
        action.stream('stderr', `\nОШИБКА: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      await action.finish(code);
      opts.after?.(code === 0);
    })();
    return action.id;
  }

  return { open, quick, background, finish };
}
