import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ActionListRow,
  BotAdmin,
  BotLink,
  BotPoll,
  BotView,
  GClientRow,
  PanelUpdateView,
  ServerDetail,
  ServerReach,
  ServerSummary,
  ServiceUpdate,
  Tag,
} from '@vps/protocol';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { internalHeaders } from '../lib/internal-auth.js';
import { deleteSetting, getJsonSetting, getSetting, putSetting } from '../lib/settings.js';
import type { Telegram, TgApiResult } from '../lib/telegram.js';
import { Refs, parseCb } from './codec.js';
import {
  COMMANDS,
  type Ctx,
  MENU,
  MENU_KEYBOARD,
  OFF_TEXT,
  STALE_TEXT,
  type Screen,
  actionView,
  findServers,
  journalView,
  offConfirmView,
  reachView,
  searchView,
  serverView,
  serversView,
  settingsView,
  summaryView,
  tagsView,
  welcomeText,
} from './views.js';

const ON_KEY = 'tg_bot_on';
const ADMIN_KEY = 'tg_bot_admin';
/** Номер следующего обновления вместе с отпечатком токена: у другого бота свои номера. */
const OFFSET_KEY = 'tg_bot_offset';
/** Ссылка привязки живёт 10 минут. */
const LINK_TTL_MS = 10 * 60_000;
/** Сообщения старше этого при первом запуске (номера ещё нет) не выполняются. */
const STALE_MESSAGE_MS = 10 * 60_000;
/** Пауза между вызовами отправки: у Telegram лимит на частоту в чате. */
const SEND_GAP_MS = 300;

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  my_chat_member?: { chat: TgChat; from: TgUser; date: number };
}

export type BotTelegram = Pick<Telegram, 'api' | 'settings' | 'health'> & {
  chatsFromBot: Telegram['chatsFromBot'];
};

export interface BotDeps {
  db: Db;
  telegram: BotTelegram;
  /** запрос к API панели (app.inject): бот видит то же, что интерфейс */
  inject: (o: InjectOptions) => Promise<LightMyRequestResponse>;
  panelUrl: string;
  version: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

class NotFound extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ответ Telegram, который ошибкой не считаем: экран не изменился. */
const notModified = (r: TgApiResult) =>
  !r.ok && /message is not modified/i.test(r.description ?? '');

/**
 * Бот администратора: принимает сообщения (long polling), отвечает только привязанному аккаунту
 * в личном чате, данные берёт из API панели. Выключен, пока не включён в настройках.
 */
export class Bot {
  private running = false;
  private wakeUp: (() => void) | null = null;
  private fails = 0;
  private pollState: BotPoll = { ok: null, lastOkAt: null, via: null, error: null };
  private username: string | null = null;
  private code: { value: string; expires: number } | null = null;
  private refs = new Refs();
  private chain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  /** кто писал боту (для "Найти chat id" в настройках), новые последними */
  private seen = new Map<string, { id: string; title: string; when: string }>();
  private strangers = new Map<number, number>();
  private commandsFor: string | null = null;

  constructor(private deps: BotDeps) {}

  // ---- состояние и настройки ----

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
      poll: { ...this.pollState },
      username: this.username,
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
        await this.send('sendMessage', {
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
    await this.send('deleteMyCommands', { scope: { type: 'chat', chat_id: a.id } });
    await this.send('sendMessage', {
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

  // ---- приём ----

  start(): () => void {
    this.running = true;
    void this.loop();
    return () => {
      this.running = false;
      this.deps.telegram.chatsFromBot = null;
      this.wake();
    };
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
    while (this.running) {
      const print = this.isOn() ? await this.tokenPrint() : null;
      if (!print) {
        this.deps.telegram.chatsFromBot = null;
        await this.nap(30_000);
        continue;
      }
      this.deps.telegram.chatsFromBot = () => [...this.seen.values()].reverse();
      const saved = getSetting(this.deps.db, OFFSET_KEY) ?? '';
      const [sp, so] = saved.split(':');
      const offset = sp === print ? Number(so) || 0 : 0;
      const r = await this.deps.telegram.api(
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
        this.pollState = {
          ...this.pollState,
          ok: false,
          error:
            r.status === 409 ? 'сообщения этого бота уже получает другая программа (409)' : r.error,
        };
        if (this.fails === 1 || this.fails % 20 === 0)
          this.deps.log.warn({ err: this.pollState.error }, 'бот: приём сообщений');
        await this.nap(Math.min(60_000, 5_000 * this.fails));
        continue;
      }
      this.fails = 0;
      this.pollState = { ok: true, lastOkAt: new Date().toISOString(), via: r.via, error: null };
      await this.ensureCommands();
      for (const u of (r.result as TgUpdate[]) ?? []) {
        // номер - до обработки: сбой посреди неё не повторит нажатие после перезапуска
        putSetting(this.deps.db, OFFSET_KEY, `${print}:${u.update_id + 1}`);
        try {
          await this.handle(u, offset !== 0);
        } catch (e) {
          this.deps.log.warn({ err: (e as Error).message }, 'бот: обработка сообщения');
        }
      }
    }
  }

  /** Меню команд в чате администратора: один раз за запуск и после привязки. */
  private async ensureCommands() {
    const a = this.admin();
    if (!a || this.commandsFor === a.id) return;
    const r = await this.send('setMyCommands', {
      commands: COMMANDS,
      scope: { type: 'chat', chat_id: a.id },
    });
    if (r.ok) this.commandsFor = a.id;
  }

  /** Обработка одного обновления; known - номер был сохранён (иначе старые сообщения пропускаем). */
  async handle(u: TgUpdate, known = true) {
    if (u.message) return this.onMessage(u.message, known);
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member) this.remember(u.my_chat_member.chat, u.my_chat_member.date);
  }

  private remember(c: TgChat, date: number) {
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
    this.remember(m.chat, m.date);
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
    const chat = m.chat.id;
    const cmd = text.replace(/@\w+$/, '').split(/\s/)[0] ?? '';
    if (cmd === '/start') {
      await this.send('sendMessage', {
        chat_id: chat,
        text: 'Меню\u00a0\u2014 кнопками внизу',
        reply_markup: MENU_KEYBOARD,
      });
      return this.reply(chat, await this.screen('m', []));
    }
    if (cmd === '/menu' || text === MENU.summary)
      return this.reply(chat, await this.screen('m', []));
    if (cmd === '/servers' || text === MENU.servers)
      return this.reply(chat, await this.screen('sl', ['-', '0']));
    if (cmd === '/log' || text === MENU.log)
      return this.reply(chat, await this.screen('lg', ['-', '0']));
    if (cmd === '/settings' || text === MENU.more)
      return this.reply(chat, await this.screen('st', []));
    if (text.startsWith('/'))
      return this.reply(chat, {
        text: 'Команды: /menu, /servers, /log, /settings',
        kb: [],
      });
    if (!text) return;
    const found = findServers(await this.get<ServerSummary[]>('/api/servers'), text);
    if (found.length === 1 && found[0])
      return this.reply(chat, await this.screen('sv', [found[0].id]));
    return this.reply(chat, searchView(text, found));
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
    await this.send('sendMessage', {
      chat_id: from.id,
      text: welcomeText(name),
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD,
    });
    await this.reply(from.id, await this.screen('m', []));
  }

  private async onCallback(q: TgCallback) {
    const answer = (text?: string, alert = false) =>
      this.send('answerCallbackQuery', {
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
    const { op, args } = parseCb(q.data ?? '');
    if (op === 'noop') return answer();
    if (op === 'off!') {
      await answer();
      await this.send('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
      await this.setOn(false, 'bot');
      return;
    }
    let screen: Screen | null;
    let toast: string | undefined;
    try {
      screen = await this.screen(op, args);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
      screen = await this.screen('sl', ['-', '0']);
      toast = 'Не найдено: возможно, удалено';
    }
    if (!screen) {
      screen = await this.screen('m', []);
      toast = STALE_TEXT;
    }
    if (screen) await this.edit(msg, screen);
    await answer(toast);
  }

  // ---- экраны ----

  private ctx(): Ctx {
    return { now: Date.now(), panelUrl: this.deps.panelUrl, ref: (v) => this.refs.put(v) };
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.deps.inject({ method: 'GET', url, headers: internalHeaders() });
    if (res.statusCode === 404) throw new NotFound(url);
    if (res.statusCode !== 200)
      throw new Error(`${url}: ${res.statusCode} ${res.body.slice(0, 200)}`);
    return res.json() as T;
  }

  private async newer(): Promise<string | null> {
    const v = await this.get<PanelUpdateView>('/api/panel/update').catch(() => null);
    return v?.newer[0]?.version ?? null;
  }

  /** Экран по операции кнопки; null - кнопка устарела (ссылка пропала после перезапуска). */
  async screen(op: string, args: string[]): Promise<Screen | null> {
    const c = this.ctx();
    const tagOf = (ref: string | undefined): string | null | undefined =>
      !ref || ref === '-' ? null : (this.refs.get(ref) ?? undefined);
    switch (op) {
      case 'm': {
        const [servers, reach, updates, clients, actions, newer] = await Promise.all([
          this.get<ServerSummary[]>('/api/servers'),
          this.get<Record<string, ServerReach>>('/api/reach'),
          this.get<Record<string, ServiceUpdate[]>>('/api/updates'),
          this.get<GClientRow[]>('/api/gclients'),
          this.get<ActionListRow[]>('/api/actions'),
          this.newer(),
        ]);
        return summaryView(
          {
            version: this.deps.version,
            newer,
            servers,
            reach,
            updates,
            clients,
            running: actions.filter((a) => !a.finishedAt),
          },
          c,
        );
      }
      case 'sl': {
        const tag = tagOf(args[0]);
        if (tag === undefined) return null;
        const [servers, reach, tags] = await Promise.all([
          this.get<ServerSummary[]>('/api/servers'),
          this.get<Record<string, ServerReach>>('/api/reach'),
          this.get<Tag[]>('/api/tags'),
        ]);
        return serversView({ servers, reach, tags }, { tag, page: Number(args[1]) || 0 }, c);
      }
      case 'tg': {
        const tag = tagOf(args[0]);
        if (tag === undefined) return null;
        const [servers, tags] = await Promise.all([
          this.get<ServerSummary[]>('/api/servers'),
          this.get<Tag[]>('/api/tags'),
        ]);
        return tagsView({ servers, tags }, tag, c);
      }
      case 'sv': {
        const id = encodeURIComponent(args[0] ?? '');
        const [s, reach, updates] = await Promise.all([
          this.get<ServerDetail>(`/api/servers/${id}`),
          this.get<ServerReach | null>(`/api/servers/${id}/reach`),
          this.get<ServiceUpdate[]>(`/api/servers/${id}/updates`),
        ]);
        return serverView({ s, reach, updates }, c);
      }
      case 'rc': {
        const id = encodeURIComponent(args[0] ?? '');
        const [s, r] = await Promise.all([
          this.get<ServerDetail>(`/api/servers/${id}`),
          this.get<ServerReach | null>(`/api/servers/${id}/reach`),
        ]);
        return reachView({ s, r }, c);
      }
      case 'lg': {
        const sid = args[0] && args[0] !== '-' ? args[0] : null;
        const [rows, servers] = await Promise.all([
          this.get<ActionListRow[]>(
            sid ? `/api/servers/${encodeURIComponent(sid)}/actions` : '/api/actions',
          ),
          this.get<ServerSummary[]>('/api/servers'),
        ]);
        const names = new Map(servers.map((s) => [s.id, s.name]));
        if (sid && !names.has(sid)) throw new NotFound(sid);
        return journalView({ rows, names, serverId: sid }, Number(args[1]) || 0, c);
      }
      case 'ac': {
        const a = await this.get<ActionListRow & { output: string }>(
          `/api/actions/${encodeURIComponent(args[0] ?? '')}`,
        );
        const servers = await this.get<ServerSummary[]>('/api/servers');
        const serverName = servers.find((s) => s.id === a.serverId)?.name ?? null;
        return actionView({ a, serverName, from: args[1] === 's' ? 's' : 'g' }, c);
      }
      case 'st':
        return settingsView(
          {
            admin: this.admin(),
            version: this.deps.version,
            newer: await this.newer(),
            health: this.deps.telegram.health(),
          },
          c,
        );
      case 'off':
        return offConfirmView();
      default:
        return null;
    }
  }

  // ---- отправка ----

  /** Вызов Bot API по очереди, с паузой; 429 - ждём, сколько сказал Telegram, и повторяем раз. */
  send(method: string, params: Record<string, unknown>): Promise<TgApiResult> {
    const run = async () => {
      const wait = this.lastSendAt + SEND_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      let r = await this.deps.telegram.api(method, params);
      if (!r.ok && r.status === 429 && r.retryAfter && r.retryAfter <= 60) {
        await sleep(r.retryAfter * 1000);
        r = await this.deps.telegram.api(method, params);
      }
      this.lastSendAt = Date.now();
      if (!r.ok && !notModified(r))
        this.deps.log.warn({ method, err: r.description ?? r.error }, 'бот: вызов Telegram');
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private markup(s: Screen) {
    return {
      inline_keyboard: s.kb.map((row) =>
        row.map((b) =>
          b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? 'noop' },
        ),
      ),
    };
  }

  private reply(chat: number | string, s: Screen | null) {
    if (!s) return;
    return this.send('sendMessage', {
      chat_id: chat,
      text: s.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.markup(s),
    });
  }

  /** Экран на месте нажатого сообщения; править нельзя (удалено, слишком старое) - новым. */
  private async edit(msg: TgMessage, s: Screen) {
    const r = await this.send('editMessageText', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: s.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.markup(s),
    });
    if (!r.ok && !notModified(r) && r.status === 400) await this.reply(msg.chat.id, s);
  }
}
