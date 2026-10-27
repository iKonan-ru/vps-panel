import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BotAdmin, BotLink, BotView, GClientRow, ServerSummary } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import { actionLog, servers } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { deleteSetting, getJsonSetting, getSetting, putSetting } from '../lib/settings.js';
import type { NotifyMeta } from '../lib/telegram.js';
import { ACTION_OPS } from './actions.js';
import { Refs, parseCb } from './codec.js';
import type { BotDeps, Core } from './core.js';
import { Flows } from './flows.js';
import { Messages } from './messages.js';
import { type BotLevel, notifyButtons } from './notify-buttons.js';
import { isNotFound, panelApi } from './panel-api.js';
import { Poller } from './poller.js';
import { Runner } from './runner.js';
import { renderScreen } from './screens.js';
import { Secrets } from './secrets.js';
import { BotStore } from './store.js';
import {
  type Answer,
  Sender,
  type TgCallback,
  type TgMessage,
  type TgUpdate,
  type TgUser,
  markup,
  sentId,
} from './transport.js';
import type { Ctx, Screen } from './views/common.js';
import {
  COMMANDS,
  MENU,
  MENU_KEYBOARD,
  OFF_TEXT,
  STALE_TEXT,
  findServers,
  searchView,
  welcomeText,
} from './views/menu.js';

export type { BotDeps, BotTelegram } from './core.js';

const ON_KEY = 'tg_bot_on';
const LEVEL_KEY = 'tg_bot_level';
const ADMIN_KEY = 'tg_bot_admin';
/** Последний экран из меню (одна "домашняя" плашка в чате вместо ленты экранов). */
const HOME_KEY = 'tg_bot_home';
/** Ссылка привязки живёт 10 минут. */
const LINK_TTL_MS = 10 * 60_000;
/** Сообщения старше этого при первом запуске (номера ещё нет) не выполняются. */
const STALE_MESSAGE_MS = 10 * 60_000;
/** Просроченное состояние бота удаляется раз в час. */
const PRUNE_MS = 3600_000;

/** Команды и кнопки постоянного меню: какой экран открыть. */
const MENU_SCREENS: Record<string, string> = {
  '/menu': 'm',
  [MENU.summary]: 'm',
  '/servers': 'sl:-:0',
  [MENU.servers]: 'sl:-:0',
  '/clients': 'gl:0:0',
  [MENU.clients]: 'gl:0:0',
  '/log': 'lg:-:0',
  [MENU.log]: 'lg:-:0',
  '/updates': 'ud',
  '/settings': 'st',
  [MENU.more]: 'st',
};

/** Нажатие кнопки: сообщение с ней, операция и ответ Telegram на нажатие. */
interface Press {
  msg: TgMessage;
  op: string;
  args: string[];
  answer: Answer;
}

/** Служебные кнопки: не экраны и не действия. */
export const PRESS_OPS = [
  'noop',
  'o',
  'ob',
  'cf',
  'cx',
  'af',
  'gk',
  'gq',
  'ga',
  'nc',
  'nd',
  'fy',
  'fs',
  'fx',
  'ic',
  'iy',
  'off!',
] as const;

/**
 * Бот администратора: принимает сообщения (long polling), отвечает только привязанному аккаунту
 * в личном чате, данные берёт из API панели. Выключен, пока не включён в настройках.
 *
 * Части: Poller - приём, Sender - отправка, Messages - одно сообщение на дело, Runner -
 * действия, Flows - мастера, Secrets - ссылки клиентов; экраны - screens.ts, действия -
 * actions.ts, виды - views/.
 */
export class Bot {
  private store: BotStore;
  private core: Core;
  private poller: Poller;
  private runner: Runner;
  private flows: Flows;
  private secrets: Secrets;
  private username: string | null = null;
  private code: { value: string; expires: number } | null = null;
  private strangers = new Map<number, number>();
  private commandsFor: string | null = null;
  private unlisten: (() => void) | null;
  private pruneTimer: NodeJS.Timeout | null = null;

  private presses: Record<(typeof PRESS_OPS)[number], (p: Press) => Promise<unknown>> = {
    noop: (p) => p.answer(),
    o: (p) => this.openFromNotify(p),
    ob: async ({ msg, answer }) => {
      await answer();
      this.core.msgs.forgetScreen(msg.chat.id, msg.message_id);
      if (!(await this.core.msgs.restore(msg.chat.id, msg.message_id)))
        await answer(STALE_TEXT, true);
    },
    cf: (p) => this.runner.onConfirm(p.msg, p.args[0] ?? '', p.answer),
    cx: async ({ msg, args, answer }) => {
      this.runner.cancel(args[0] ?? '');
      await answer();
      await this.core.msgs.cancelIn(msg.chat.id, msg.message_id);
    },
    af: (p) => this.runner.outputFile(p.msg, p.args[0] ?? '', p.answer),
    gk: (p) => this.secrets.handle(p.msg, p.op, p.args, p.answer),
    gq: (p) => this.secrets.handle(p.msg, p.op, p.args, p.answer),
    ga: (p) => this.secrets.handle(p.msg, p.op, p.args, p.answer),
    nc: (p) => this.flows.onButton(p.msg, p.op, p.args, p.answer),
    nd: (p) => this.flows.onButton(p.msg, p.op, p.args, p.answer),
    fy: (p) => this.flows.onButton(p.msg, p.op, p.args, p.answer),
    fs: (p) => this.flows.onButton(p.msg, p.op, p.args, p.answer),
    fx: (p) => this.flows.onButton(p.msg, p.op, p.args, p.answer),
    ic: (p) => this.flows.onIpButton(p.msg, p.op, p.args, p.answer),
    iy: (p) => this.flows.onIpButton(p.msg, p.op, p.args, p.answer),
    'off!': async ({ msg, answer }) => {
      await answer();
      await this.core.tg.remove(msg.chat.id, msg.message_id);
      await this.setOn(false, 'bot');
    },
  };

  constructor(private deps: BotDeps) {
    this.store = new BotStore(deps.db);
    const tg = new Sender((m, p, t) => deps.telegram.api(m, p, t), deps.log);
    const refs = new Refs(this.store);
    const core: Omit<Core, 'msgs'> = {
      deps,
      tg,
      api: panelApi(deps.inject),
      refs,
      store: this.store,
      level: () => this.level(),
      ctx: (): Ctx => ({ now: Date.now(), panelUrl: deps.panelUrl, ref: (v) => refs.put(v) }),
      screen: (op, args) => this.screen(op, args),
    };
    this.core = { ...core, msgs: new Messages(core) };
    this.runner = new Runner(this.core);
    this.flows = new Flows(this.core);
    this.secrets = new Secrets(this.core);
    this.poller = new Poller(deps, {
      enabled: () => this.isOn(),
      update: async (u, known) => {
        await this.handle(u, known);
      },
      polled: () => this.ensureCommands(),
    });
    deps.telegram.buttons = (m) => this.notifyMarkup(m);
    // ход действий, запущенных из бота, - и без приёма сообщений (тесты, стенд)
    this.unlisten = deps.hub?.listen((ev) => this.runner.onHub(ev)) ?? null;
  }

  // ---- состояние и настройки ----

  level(): BotLevel {
    const v = getSetting(this.deps.db, LEVEL_KEY);
    return v === 'view' || v === 'safe' ? v : 'all';
  }

  setLevel(level: BotLevel) {
    putSetting(this.deps.db, LEVEL_KEY, level);
  }

  private isOn(): boolean {
    return getSetting(this.deps.db, ON_KEY) === '1';
  }

  admin(): BotAdmin | null {
    const a = getJsonSetting<BotAdmin | null>(this.deps.db, ADMIN_KEY, null);
    return a && typeof a.id === 'string' ? a : null;
  }

  view(): BotView {
    return {
      on: this.isOn(),
      admin: this.admin(),
      poll: { ...this.poller.state },
      username: this.username,
      level: this.level(),
    };
  }

  /** Включить или выключить приём сообщений; выключение снимает меню у администратора. */
  async setOn(on: boolean, by: 'panel' | 'bot' = 'panel') {
    const was = this.isOn();
    putSetting(this.deps.db, ON_KEY, on ? '1' : '0');
    this.wake();
    if (!on && was) {
      if (by === 'bot') this.record('bot.off', {}, 'telegram');
      const a = this.admin();
      if (a)
        await this.core.tg.send('sendMessage', {
          chat_id: a.id,
          text: OFF_TEXT,
          parse_mode: 'HTML',
          reply_markup: { remove_keyboard: true },
        });
    }
  }

  /** Ссылка привязки аккаунта: одноразовая, 10 минут; заодно включает бота. */
  async link(): Promise<BotLink> {
    const me = await this.deps.telegram.api('getMe', {});
    if (!me.ok) throw Object.assign(new Error(me.error), { statusCode: 502 });
    this.username = (me.result as { username?: string }).username ?? null;
    if (!this.username)
      throw Object.assign(new Error('Telegram не вернул имя бота'), { statusCode: 502 });
    const expires = Date.now() + LINK_TTL_MS;
    this.code = { value: randomBytes(12).toString('base64url'), expires };
    putSetting(this.deps.db, ON_KEY, '1');
    this.wake();
    return {
      url: `https://t.me/${this.username}?start=${this.code.value}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  async unbind() {
    const a = this.admin();
    if (!a) return;
    deleteSetting(this.deps.db, ADMIN_KEY);
    this.commandsFor = null;
    this.record('bot.unbind', { name: a.name });
    await this.core.tg.send('deleteMyCommands', { scope: { type: 'chat', chat_id: a.id } });
    await this.core.tg.send('sendMessage', {
      chat_id: a.id,
      text: 'Аккаунт отвязан от VPS Panel',
      reply_markup: { remove_keyboard: true },
    });
  }

  /** Запись в журнал действий панели (без сервера). */
  private record(kind: string, params: Record<string, unknown>, initiator = 'admin') {
    const now = new Date().toISOString();
    this.deps.db
      .insert(actionLog)
      .values({
        id: newId(),
        serverId: null,
        kind,
        params,
        startedAt: now,
        finishedAt: now,
        exitCode: 0,
        output: '',
        initiator,
      })
      .run();
  }

  // ---- запуск ----

  start(): () => void {
    this.unlisten ??= this.deps.hub?.listen((ev) => this.runner.onHub(ev)) ?? null;
    this.store.prune();
    this.pruneTimer = setInterval(() => this.store.prune(), PRUNE_MS);
    this.pruneTimer.unref?.();
    this.secrets.schedule();
    this.runner.resume().catch((e) => {
      this.deps.log.warn({ err: (e as Error).message }, 'бот: действия после перезапуска');
    });
    this.poller.start();
    return () => {
      this.poller.stop();
      this.unlisten?.();
      this.unlisten = null;
      this.runner.stop();
      this.secrets.stop();
      if (this.pruneTimer) clearInterval(this.pruneTimer);
    };
  }

  /** Прервать паузу приёма: настройки изменились. */
  wake() {
    this.poller.wake();
  }

  /** Меню команд в чате администратора: один раз за запуск и после привязки. */
  private async ensureCommands() {
    const a = this.admin();
    if (!a || this.commandsFor === a.id) return;
    const r = await this.core.tg.send('setMyCommands', {
      commands: COMMANDS,
      scope: { type: 'chat', chat_id: a.id },
    });
    if (r.ok) this.commandsFor = a.id;
  }

  /** Кнопки к уведомлению: только когда управление включено и аккаунт привязан. */
  private async notifyMarkup(m: NotifyMeta): Promise<unknown | null> {
    try {
      return this.notifyKeyboard(m);
    } catch (e) {
      // кнопки - не повод потерять уведомление
      this.deps.log.warn({ err: (e as Error).message }, 'бот: кнопки уведомления');
      return null;
    }
  }

  private notifyKeyboard(m: NotifyMeta): unknown | null {
    if (!this.isOn() || !this.admin()) return null;
    let providerUrl: string | undefined;
    if (m.serverId && (m.event === 'offline' || m.event === 'payment'))
      providerUrl =
        this.deps.db
          .select({ url: servers.providerUrl })
          .from(servers)
          .where(eq(servers.id, m.serverId))
          .get()?.url ?? undefined;
    const kb = notifyButtons({ ...m, providerUrl }, this.level(), (v) => this.core.refs.put(v));
    return kb.length ? markup({ text: '', kb }) : null;
  }

  // ---- приём ----

  /** Обработка одного обновления; known - номер был сохранён (иначе старые сообщения пропускаем). */
  async handle(u: TgUpdate, known = true) {
    if (u.message) return this.onMessage(u.message, known);
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member) this.poller.remember(u.my_chat_member.chat, u.my_chat_member.date);
  }

  private isAdmin(id: number): boolean {
    return this.admin()?.id === String(id);
  }

  /** Чужой аккаунт: не отвечаем, в журнал сервера - не чаще раза в 10 минут на аккаунт. */
  private stranger(u: TgUser | undefined) {
    if (!u) return;
    const now = Date.now();
    if (now - (this.strangers.get(u.id) ?? 0) < 10 * 60_000) return;
    this.strangers.set(u.id, now);
    this.deps.log.warn({ userId: u.id }, 'бот: сообщение от непривязанного аккаунта, без ответа');
  }

  private codeMatches(value: string): boolean {
    const c = this.code;
    if (!c || Date.now() > c.expires) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(c.value);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async onMessage(m: TgMessage, known: boolean) {
    this.poller.remember(m.chat, m.date);
    if (!known && Date.now() - m.date * 1000 > STALE_MESSAGE_MS) return;
    const from = m.from;
    if (!from || from.is_bot) return;
    const text = (m.text ?? '').trim();
    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(text);
    if (start && m.chat.type === 'private' && this.codeMatches(start[1] ?? '')) {
      await this.bind(from);
      return;
    }
    if (!this.isAdmin(from.id) || m.chat.type !== 'private') {
      this.stranger(from);
      return;
    }
    const { tg, msgs } = this.core;
    const chat = m.chat.id;
    const digits = text.replace(/\s+/g, '');
    if (this.runner.waitsCode() && /^\d{6}$/.test(digits)) {
      await tg.remove(chat, m.message_id);
      return this.runner.onCode(digits);
    }
    const cmd = text.replace(/@\w+$/, '').split(/\s/)[0] ?? '';
    if (cmd === '/cancel') {
      for (const w of [this.runner.dropCodeWait(), this.flows.drop()])
        if (w) await msgs.cancelIn(w.chat, w.mid);
      await tg.remove(chat, m.message_id);
      return;
    }
    const menuText = Object.values(MENU).includes(text);
    if (this.flows.active() && text && !text.startsWith('/') && !menuText)
      return this.flows.onText(m, text);
    if (cmd === '/start') {
      await tg.send('sendMessage', {
        chat_id: chat,
        text: 'Меню\u00a0\u2014 кнопками внизу',
        reply_markup: MENU_KEYBOARD,
      });
      return this.home(chat, m.message_id, 'm');
    }
    const go = MENU_SCREENS[cmd] ?? MENU_SCREENS[text];
    if (go) return this.home(chat, m.message_id, go);
    if (text.startsWith('/'))
      return this.home(chat, m.message_id, '', {
        text: 'Команды: /menu, /servers, /clients, /log, /settings',
        kb: [],
      });
    if (text) await this.search(chat, m.message_id, text);
  }

  /** Поиск сервера (имя, адрес) и клиента (имя); одно совпадение - сразу его карточка. */
  private async search(chat: number, mid: number, text: string) {
    const { api } = this.core;
    const [list, rows] = await Promise.all([
      api.get<ServerSummary[]>('/api/servers'),
      api.get<GClientRow[]>('/api/gclients'),
    ]);
    const found = findServers(list, text);
    const qq = text.toLocaleLowerCase('ru');
    const exact = rows.filter((r) => r.name.toLocaleLowerCase('ru') === qq);
    const clients = exact.length
      ? exact
      : rows.filter((r) => r.name.toLocaleLowerCase('ru').includes(qq));
    if (found.length === 1 && !clients.length && found[0])
      return this.home(chat, mid, `sv:${found[0].id}`);
    if (clients.length === 1 && !found.length && clients[0])
      return this.home(chat, mid, `gc:${clients[0].id}`);
    return this.home(chat, mid, '', searchView(text, found, clients));
  }

  private async bind(from: TgUser) {
    this.code = null;
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      from.username ||
      String(from.id);
    const admin: BotAdmin = {
      id: String(from.id),
      name,
      username: from.username ?? '',
      at: new Date().toISOString(),
    };
    putSetting(this.deps.db, ADMIN_KEY, JSON.stringify(admin));
    this.commandsFor = null;
    this.record('bot.bind', { name });
    await this.ensureCommands();
    await this.core.tg.send('sendMessage', {
      chat_id: from.id,
      text: welcomeText(name),
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD,
    });
    await this.home(from.id, null, 'm');
  }

  /**
   * Экран из меню, команды или поиска - одна "домашняя" плашка в чате: прежняя удаляется
   * (если в ней не идёт действие или мастер), сообщение администратора тоже. data - чем
   * открыть экран заново; screen - готовый (поиск).
   */
  private async home(chat: number, userMid: number | null, data: string, screen?: Screen) {
    const { tg, msgs } = this.core;
    if (userMid) await tg.remove(chat, userMid);
    let s: Screen | null | undefined = screen;
    if (!s) {
      const { op, args } = parseCb(data);
      s = await this.screen(op, args).catch((e) => {
        if (isNotFound(e)) return null;
        throw e;
      });
    }
    if (!s) return;
    const prev = getJsonSetting<{ chat: string; id: number } | null>(this.deps.db, HOME_KEY, null);
    const busy =
      prev &&
      (this.runner.busyIn(prev.id) ||
        this.flows.busyIn(prev.id) ||
        msgs.hasOrigin(prev.chat, prev.id));
    if (prev && prev.chat === String(chat) && !busy) await tg.remove(chat, prev.id);
    const mid = sentId(await tg.reply(chat, s));
    if (!mid) return;
    putSetting(this.deps.db, HOME_KEY, JSON.stringify({ chat: String(chat), id: mid }));
    if (data) msgs.rememberScreen(chat, mid, data);
  }

  private async onCallback(q: TgCallback) {
    const answer: Answer = (text, alert = false) =>
      this.core.tg.send('answerCallbackQuery', {
        callback_query_id: q.id,
        ...(text ? { text, show_alert: alert } : {}),
      });
    if (!this.isAdmin(q.from.id)) {
      this.stranger(q.from);
      await answer();
      return;
    }
    const msg = q.message;
    if (!msg) return answer();
    if (msg.chat.type !== 'private')
      return answer('Управление\u00a0\u2014 в личном чате с ботом', true);
    const data = q.data ?? '';
    const { op, args } = parseCb(data);
    if (ACTION_OPS.has(op)) return this.runner.onAction(msg, data, op, args, answer);
    const press = Object.hasOwn(this.presses, op)
      ? this.presses[op as (typeof PRESS_OPS)[number]]
      : undefined;
    if (press) return press({ msg, op, args, answer });
    await this.navigate(msg, data, answer);
  }

  /** Переход на экран на месте нажатого сообщения. */
  private async navigate(msg: TgMessage, data: string, answer: Answer) {
    const { op, args } = parseCb(data);
    let screen: Screen | null;
    let toast: string | undefined;
    let shown = data;
    try {
      screen = await this.screen(op, args);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      screen = await this.screen('sl', ['-', '0']);
      shown = 'sl:-:0';
      toast = 'Не найдено: возможно, удалено';
    }
    if (!screen) {
      screen = await this.screen('m', []);
      shown = 'm';
      toast = STALE_TEXT;
    }
    if (screen) {
      this.core.msgs.rememberScreen(msg.chat.id, msg.message_id, shown);
      await this.core.msgs.edit(msg, screen);
    }
    await answer(toast);
  }

  /** Переход из уведомления - на месте, с кнопкой возврата к уведомлению. */
  private async openFromNotify({ msg, args, answer }: Press) {
    const [sub = '', ...rest] = args;
    const screen = await this.screen(sub, rest).catch((e) => {
      if (isNotFound(e)) return null;
      throw e;
    });
    await answer(screen ? undefined : 'Не найдено: возможно, удалено');
    if (!screen) return;
    const { msgs } = this.core;
    msgs.stash(msg);
    msgs.rememberScreen(msg.chat.id, msg.message_id, [sub, ...rest].join(':'));
    await msgs.paint(msg.chat.id, msg.message_id, screen);
  }

  // ---- экраны ----

  /** Экран по операции кнопки; null - кнопка устарела (ссылка пропала). */
  screen(op: string, args: string[]): Promise<Screen | null> {
    const { refs } = this.core;
    return renderScreen(op, args, {
      api: this.core.api,
      ctx: this.core.ctx(),
      ref: (key) => (!key || key === '-' ? null : (refs.get(key) ?? undefined)),
      admin: () => this.admin(),
      version: this.deps.version,
      health: () => this.deps.telegram.health(),
    });
  }
}
