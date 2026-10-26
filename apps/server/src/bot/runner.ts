import { randomBytes } from 'node:crypto';
import { type ActionListRow, actionTitle } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import { sessions } from '../db/schema.js';
import { deleteAllSessions, theAdmin, verifyTotp } from '../lib/auth.js';
import { esc } from '../lib/telegram.js';
import type { UiEvent } from '../lib/ui-hub.js';
import { type ActionDeps, type ActionSpec, type RunResult, actionSpec } from './actions.js';
import { type Core, refusal } from './core.js';
import { ApiError, isNotFound } from './panel-api.js';
import type { Answer, ChatId, TgMessage } from './transport.js';
import { type Btn, I, cut, lastLine } from './views/common.js';
import { codeView, confirmView, progressText } from './views/journal.js';
import { STALE_TEXT } from './views/menu.js';

/** Подтверждение и ввод кода 2FA ждут 2 минуты. */
const CONFIRM_TTL_MS = 2 * 60_000;
/** Неверных кодов подряд до блокировки действий и на сколько. */
const CODE_FAILS = 5;
const CODE_LOCK_MS = 15 * 60_000;
/** Ход действия правится не чаще. */
const PROGRESS_EDIT_MS = 15_000;
/** Telegram ждёт ответа на нажатие недолго: дольше - сначала "идёт", итог потом. */
const ACK_MS = 4_000;
/** За действием, запущенным из бота, следим не дольше суток (и после перезапуска панели). */
const TRACK_TTL_MS = 24 * 3600_000;
const TRACK = 'track';

/** Действие, ждущее подтверждения: что запустить и какая кнопка его открыла. */
interface Confirm {
  op: string;
  args: string[];
  data: string;
  expires: number;
}

/** Ход действия, запущенного из бота: в каком сообщении он показывается. */
interface Tracked {
  chat: ChatId;
  mid: number;
  header: string;
  startedAt: number;
  /** итог при успехе (HTML) */
  done: string | null;
  /** чем запущено: после перезапуска панели - для кнопок под итогом */
  op: string;
  args: string[];
  /** у действия есть кнопки под итогом: после перезапуска описание собирается заново */
  after: boolean;
}

type ActionRow = ActionListRow & { output: string };

/** Заголовок хода и итога: "<b>Сервер</b>: что идёт" или "<b>Что идёт</b>". */
function headerOf(spec: ActionSpec): string {
  if (spec.serverName) return `<b>${esc(spec.serverName)}</b>: ${esc(spec.title)}`;
  return `<b>${esc(spec.title[0]?.toUpperCase() ?? '')}${esc(spec.title.slice(1))}</b>`;
}

/**
 * Действия из бота: проверка уровня доступа, подтверждение, код 2FA (только удаление сервера),
 * запуск и ход в том же сообщении, итог на его месте.
 */
export class Runner {
  private confirms = new Map<string, Confirm>();
  /** ждёт кода 2FA: подтверждение и сообщение, которое правится */
  private codeWait: { token: string; chat: number; mid: number; expires: number } | null = null;
  private codeFails = 0;
  private lockedUntil = 0;
  private usedCodes = new Map<string, number>();
  /** за чем следим: действие - сообщение; таймеры хода - только в памяти */
  private tracked = new Map<string, Tracked>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** описания запущенных сейчас действий (кнопки под итогом) */
  private specs = new Map<string, ActionSpec>();

  constructor(private core: Core) {}

  // ---- состояние ----

  /** В сообщении идёт действие или ждёт код: его не трогать. */
  busyIn(mid: number): boolean {
    return [...this.tracked.values()].some((t) => t.mid === mid) || this.codeWait?.mid === mid;
  }

  waitsCode(): boolean {
    return this.codeWait !== null;
  }

  /** Бросить ожидание кода (/cancel): сообщение, где оно было. */
  dropCodeWait(): { chat: number; mid: number } | null {
    const w = this.codeWait;
    this.codeWait = null;
    return w;
  }

  /** "Отмена" в подтверждении. */
  cancel(token: string) {
    this.confirms.delete(token);
    if (this.codeWait?.token === token) this.codeWait = null;
  }

  private specDeps(): ActionDeps {
    const { db, telegram } = this.core.deps;
    return {
      api: this.core.api,
      refValue: (k) => this.core.refs.get(k),
      muteUntil: (id, until) => telegram.muteUntil(id, until),
      logoutAll: async () => {
        const a = await theAdmin(db);
        if (!a) return 0;
        const n = db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.adminId, a.id))
          .all().length;
        await deleteAllSessions(db, a.id);
        return n;
      },
      now: () => Date.now(),
    };
  }

  private spec(op: string, args: string[]) {
    return actionSpec(op, args, this.specDeps());
  }

  // ---- нажатие, подтверждение, код ----

  async onAction(msg: TgMessage, data: string, op: string, args: string[], answer: Answer) {
    let spec: ActionSpec | null;
    try {
      spec = await this.spec(op, args);
    } catch (e) {
      await answer(isNotFound(e) ? 'Не найдено: возможно, удалено' : (e as Error).message, true);
      return;
    }
    if (!spec) return answer(STALE_TEXT, true);
    const no = refusal(this.core.level(), spec.risk);
    if (no) return answer(no, true);
    if (spec.stale) {
      await answer(spec.stale, true);
      await this.dropButton(msg, data);
      return;
    }
    this.core.msgs.stash(msg);
    if (spec.risk === 'safe') {
      await this.execute(spec, { op, args }, msg.chat.id, msg.message_id, data, answer);
      return;
    }
    const token = randomBytes(6).toString('base64url');
    this.confirms.set(token, { op, args, data, expires: Date.now() + CONFIRM_TTL_MS });
    await answer();
    await this.core.tg.show(
      msg.chat.id,
      msg.message_id,
      confirmView(spec.question, spec.verb, token),
    );
  }

  async onConfirm(msg: TgMessage, token: string, answer: Answer) {
    const chat = msg.chat.id;
    const c = this.confirms.get(token);
    if (!c || Date.now() > c.expires) {
      this.confirms.delete(token);
      await answer('Подтверждение устарело, нажмите кнопку действия ещё раз', true);
      await this.core.msgs.cancelIn(chat, msg.message_id);
      return;
    }
    let spec: ActionSpec | null;
    try {
      spec = await this.spec(c.op, c.args);
    } catch (e) {
      return answer(isNotFound(e) ? 'Не найдено: возможно, удалено' : (e as Error).message, true);
    }
    if (!spec) return answer(STALE_TEXT, true);
    const no = refusal(this.core.level(), spec.risk);
    if (no) return answer(no, true);
    if (spec.stale) {
      this.confirms.delete(token);
      await answer(spec.stale, true);
      await this.core.msgs.restore(chat, msg.message_id, c.data);
      return;
    }
    if (spec.risk === 'code') {
      if (Date.now() < this.lockedUntil)
        return answer('Слишком много неверных кодов: действия недоступны 15 минут', true);
      const admin = await theAdmin(this.core.deps.db);
      if (!admin?.totpEnabled || !admin.totpSecret)
        return answer('Двухфакторная аутентификация не настроена: войдите в панель', true);
      c.expires = Date.now() + CONFIRM_TTL_MS;
      this.codeWait = { token, chat, mid: msg.message_id, expires: c.expires };
      await answer();
      await this.core.tg.show(chat, msg.message_id, codeView(spec.question, token));
      return;
    }
    this.confirms.delete(token);
    await this.execute(spec, c, chat, msg.message_id, c.data, answer);
  }

  /** Код 2FA сообщением (удаление сервера): верный - действие, неверный - счётчик попыток. */
  async onCode(code: string) {
    const w = this.codeWait;
    if (!w) return;
    const c = this.confirms.get(w.token);
    if (!c || Date.now() > w.expires) {
      this.codeWait = null;
      await this.core.msgs.cancelIn(w.chat, w.mid);
      return;
    }
    const admin = await theAdmin(this.core.deps.db);
    const now = Date.now();
    for (const [k, at] of this.usedCodes) if (now - at > 120_000) this.usedCodes.delete(k);
    const ok =
      Boolean(admin?.totpSecret) &&
      !this.usedCodes.has(code) &&
      verifyTotp(admin?.totpSecret ?? '', code);
    const spec = await this.spec(c.op, c.args).catch(() => null);
    if (!ok) {
      this.codeFails++;
      if (this.codeFails >= CODE_FAILS) {
        this.codeFails = 0;
        this.lockedUntil = now + CODE_LOCK_MS;
        this.codeWait = null;
        this.confirms.delete(w.token);
        this.core.deps.log.warn({}, 'бот: неверные коды 2FA, действия заблокированы на 15 минут');
        await this.core.msgs.fail(
          w.chat,
          w.mid,
          'Неверный код. Действия через бота недоступны 15\u00a0минут',
        );
        return;
      }
      const left = CODE_FAILS - this.codeFails;
      const v = codeView(spec?.question ?? '', w.token, `Неверный код, попыток: ${left}`);
      await this.core.tg.show(w.chat, w.mid, v);
      return;
    }
    this.usedCodes.set(code, now);
    this.codeFails = 0;
    this.codeWait = null;
    this.confirms.delete(w.token);
    if (!spec || spec.stale) {
      await this.core.msgs.cancelIn(w.chat, w.mid);
      return;
    }
    await this.execute(spec, c, w.chat, w.mid, c.data);
  }

  // ---- выполнение ----

  /**
   * Выполнить действие в сообщении mid (уведомление, экран или подтверждение на их месте).
   * Короткий итог - всплывающим сообщением, если успели ответить на нажатие; длинное действие -
   * "идёт" с временем, по окончании - итог на месте. pressed - данные нажатой кнопки (её
   * снимают, когда действие больше не нужно).
   */
  private async execute(
    spec: ActionSpec,
    from: { op: string; args: string[] },
    chat: ChatId,
    mid: number,
    pressed: string,
    answer?: Answer,
  ) {
    const { tg, msgs } = this.core;
    const header = headerOf(spec);
    let answered = !answer;
    const ack = async (text?: string, alert = false): Promise<boolean> => {
      if (answered) return false;
      answered = true;
      await answer?.(text, alert);
      return true;
    };
    const slow = setTimeout(() => {
      void ack();
      void tg.editText(chat, mid, progressText(header, Date.now(), Date.now()));
    }, ACK_MS);
    slow.unref?.();
    let res: RunResult;
    try {
      res = await spec.run();
    } catch (e) {
      clearTimeout(slow);
      const m =
        e instanceof ApiError && e.status === 409
          ? `сервер занят: ${e.message}`
          : (e as Error).message;
      if (await ack(cut(m, 190), true)) await msgs.cancelIn(chat, mid);
      else await msgs.fail(chat, mid, `${I.fail} ${header}: ${esc(m)}`);
      return;
    }
    clearTimeout(slow);
    if ('toast' in res) {
      const shown = await ack(res.toast);
      if (res.reopen) {
        await msgs.reopen(chat, mid, res.reopen.op, res.reopen.args);
        msgs.release(chat, mid);
        if (!shown) await tg.send('sendChatAction', { chat_id: chat, action: 'typing' });
      } else if (!(await msgs.restore(chat, mid, res.drop ? pressed : undefined)) && !shown)
        await tg.editText(chat, mid, esc(res.toast));
      return;
    }
    await ack();
    if ('screen' in res || 'reopen' in res) {
      if ('screen' in res) await msgs.paint(chat, mid, res.screen);
      else await msgs.reopen(chat, mid, res.reopen.op, res.reopen.args);
      msgs.release(chat, mid);
    } else if ('text' in res) await msgs.settle(chat, mid, res.text, res.kb ?? []);
    else await this.track(res.actionId, spec, { chat, mid, header, op: from.op, args: from.args });
  }

  /** Следить за длинным действием: "идёт" с временем, итог - по событию окончания. */
  private async track(
    actionId: string,
    spec: ActionSpec,
    at: Pick<Tracked, 'chat' | 'mid' | 'header' | 'op' | 'args'>,
  ) {
    const t: Tracked = {
      ...at,
      startedAt: Date.now(),
      done: spec.done ?? null,
      after: Boolean(spec.after),
    };
    this.specs.set(actionId, spec);
    await this.core.tg.editText(t.chat, t.mid, progressText(t.header, t.startedAt, t.startedAt));
    this.follow(actionId, t);
    // короткое действие могло закончиться раньше, чем бот начал следить
    await this.checkFinished(actionId);
  }

  private follow(actionId: string, t: Tracked) {
    const left = TRACK_TTL_MS - (Date.now() - t.startedAt);
    if (left <= 0) {
      void this.giveUp(actionId, t);
      return;
    }
    this.tracked.set(actionId, t);
    this.core.store.put(TRACK, actionId, t, left);
    // раз в 15 секунд - сколько идёт: видно, что не зависло
    const timer = setInterval(() => {
      if (Date.now() - t.startedAt > TRACK_TTL_MS) void this.giveUp(actionId, t);
      else
        void this.core.tg.editText(t.chat, t.mid, progressText(t.header, t.startedAt, Date.now()));
    }, PROGRESS_EDIT_MS);
    timer.unref?.();
    this.timers.set(actionId, timer);
  }

  /** Сутки без итога: больше не следим, итог - в журнале действий. */
  private async giveUp(actionId: string, t: Tracked) {
    this.forget(actionId);
    await this.core.msgs.fail(
      t.chat,
      t.mid,
      `${I.warn} ${t.header}: итога нет больше суток, он будет в журнале действий`,
    );
  }

  private forget(actionId: string) {
    this.tracked.delete(actionId);
    clearInterval(this.timers.get(actionId));
    this.timers.delete(actionId);
    this.core.store.delete(TRACK, actionId);
  }

  private async checkFinished(actionId: string) {
    const row = await this.row(actionId);
    if (row?.finishedAt) await this.finish(actionId);
  }

  private row(id: string) {
    return this.core.api.get<ActionRow>(`/api/actions/${encodeURIComponent(id)}`).catch(() => null);
  }

  /** После перезапуска панели: досмотреть действия, запущенные из бота (прерванные - итогом). */
  async resume() {
    for (const { key, value } of this.core.store.list<Tracked>(TRACK)) {
      if (this.tracked.has(key)) continue;
      this.follow(key, value);
      await this.checkFinished(key);
    }
  }

  onHub(ev: UiEvent) {
    if (ev.type === 'action.finished' && this.tracked.has(ev.actionId))
      void this.finish(ev.actionId);
  }

  stop() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  private async finish(actionId: string) {
    const t = this.tracked.get(actionId);
    if (!t) return;
    this.forget(actionId);
    // после перезапуска описание собирается заново только ради кнопок под итогом
    const spec =
      this.specs.get(actionId) ??
      (t.after ? await this.spec(t.op, t.args).catch(() => null) : null);
    this.specs.delete(actionId);
    const a = await this.row(actionId);
    if (!a) return;
    const ok = a.exitCode === 0;
    const extra: Btn[][] = (await spec?.after?.(ok).catch(() => [])) ?? [];
    if (ok) {
      await this.core.msgs.settle(
        t.chat,
        t.mid,
        `${I.done} ${t.done ?? `${t.header}: готово`}`,
        extra,
      );
      return;
    }
    const why = lastLine(a.output);
    const code = a.exitCode !== null ? `, код ${a.exitCode}` : '';
    const text = `${I.fail} ${t.header}: ошибка${code}${why ? `\n<i>${esc(why)}</i>` : ''}`;
    await this.core.msgs.fail(t.chat, t.mid, text, [
      ...extra,
      [{ text: 'Вывод файлом', data: `af:${actionId}` }],
    ]);
  }

  /** Вывод действия целиком - файлом в чат. */
  async outputFile(msg: TgMessage, id: string, answer: Answer) {
    const a = await this.row(id);
    if (!a) return answer('Действие не найдено', true);
    await answer();
    const err = await this.core.deps.telegram.sendDocument(
      `action-${a.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.txt`,
      Buffer.from(a.output, 'utf8'),
      esc(actionTitle(a.kind, a.params)),
      String(msg.chat.id),
    );
    if (err) await answer(err, true);
  }

  /** Убрать нажатую кнопку из сообщения: действие уже не нужно. */
  private async dropButton(msg: TgMessage, data: string) {
    const rows = msg.reply_markup?.inline_keyboard;
    if (!rows) return;
    const left = rows.map((r) => r.filter((b) => b.callback_data !== data)).filter((r) => r.length);
    await this.core.tg.send('editMessageReplyMarkup', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: left },
    });
  }
}
