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
    await db
      .update(actionLog)
      .set({ finishedAt: new Date().toISOString(), exitCode, output: output.slice(-MAX_OUTPUT) })
      .where(eq(actionLog.id, id));
    hub.broadcast({ type: 'action.finished', serverId, actionId: id, exitCode });
    // после любого действия просим агента прислать свежий inventory: интерфейс обновится сам
    void registry.refreshInventory(serverId);
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

  return {
    open,
    /** Начать без стрима; сервер занят другим действием - исключение 409. */
    async start(serverId: string, kind: string, params: Record<string, unknown> = {}) {
      return open(serverId, kind, params).id;
    },
    finish,
  };
}
