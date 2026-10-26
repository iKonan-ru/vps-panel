import { createHash } from 'node:crypto';
import type { BotPoll } from '@vps/protocol';
import { getSetting, putSetting } from '../lib/settings.js';
import type { BotDeps } from './core.js';
import type { TgChat, TgUpdate } from './transport.js';

/** Номер следующего обновления вместе с отпечатком токена: у другого бота свои номера. */
const OFFSET_KEY = 'tg_bot_offset';

/**
 * Приём сообщений бота (long polling getUpdates) и список чатов, писавших боту (для "Найти chat
 * id" в настройках уведомлений). Пока бот выключен или токена нет - ждёт.
 */
export class Poller {
  private running = false;
  private wakeUp: (() => void) | null = null;
  private fails = 0;
  state: BotPoll = { ok: null, lastOkAt: null, via: null, error: null };
  /** кто писал боту, новые последними */
  private seen = new Map<string, { id: string; title: string; when: string }>();

  constructor(
    private deps: BotDeps,
    private on: {
      /** бот включён в настройках */
      enabled: () => boolean;
      /** обновление; known - номер был сохранён (иначе старые сообщения пропускаем) */
      update: (u: TgUpdate, known: boolean) => Promise<void>;
      /** приём прошёл: меню команд и прочее, что нужно, когда связь есть */
      polled: () => Promise<void>;
    },
  ) {}

  start() {
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
    this.deps.telegram.chatsFromBot = null;
    this.wake();
  }

  /** Прервать паузу цикла: настройки изменились. */
  wake() {
    this.wakeUp?.();
  }

  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.wakeUp === done) self.wakeUp = null;
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private async tokenPrint(): Promise<string | null> {
    const st = await this.deps.telegram.settings();
    if (!st.token) return null;
    return createHash('sha256').update(st.token).digest('hex').slice(0, 8);
  }

  private async loop() {
    const { db, telegram, log } = this.deps;
    while (this.running) {
      const print = this.on.enabled() ? await this.tokenPrint() : null;
      if (!print) {
        telegram.chatsFromBot = null;
        await this.nap(30_000);
        continue;
      }
      telegram.chatsFromBot = () => [...this.seen.values()].reverse();
      const [sp, so] = (getSetting(db, OFFSET_KEY) ?? '').split(':');
      const offset = sp === print ? Number(so) || 0 : 0;
      const r = await telegram.api(
        'getUpdates',
        {
          ...(offset ? { offset } : {}),
          timeout: 25,
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        },
        40_000,
      );
      if (!this.running) break;
      if (!r.ok) {
        this.fails++;
        this.state = {
          ...this.state,
          ok: false,
          error:
            r.status === 409 ? 'сообщения этого бота уже получает другая программа (409)' : r.error,
        };
        if (this.fails === 1 || this.fails % 20 === 0)
          log.warn({ err: this.state.error }, 'бот: приём сообщений');
        await this.nap(Math.min(60_000, 5_000 * this.fails));
        continue;
      }
      this.fails = 0;
      this.state = { ok: true, lastOkAt: new Date().toISOString(), via: r.via, error: null };
      await this.on.polled();
      for (const u of (r.result as TgUpdate[]) ?? []) {
        // номер - до обработки: сбой посреди неё не повторит нажатие после перезапуска
        putSetting(db, OFFSET_KEY, `${print}:${u.update_id + 1}`);
        try {
          await this.on.update(u, offset !== 0);
        } catch (e) {
          log.warn({ err: (e as Error).message }, 'бот: обработка сообщения');
        }
      }
    }
  }

  /** Запомнить чат, писавший боту (последние 20). */
  remember(c: TgChat, date: number) {
    const title =
      c.title ||
      [c.first_name, c.last_name].filter(Boolean).join(' ') ||
      (c.username ? `@${c.username}` : String(c.id));
    const kind = c.type === 'private' ? 'личный чат' : c.type === 'channel' ? 'канал' : 'группа';
    const id = String(c.id);
    this.seen.delete(id);
    this.seen.set(id, {
      id,
      title: `${title} (${kind})`,
      when: new Date(date * 1000).toISOString(),
    });
    while (this.seen.size > 20) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
  }
}
