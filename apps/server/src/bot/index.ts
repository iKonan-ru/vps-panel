import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ActionListRow,
  BackupInfo,
  BaselinePlan,
  BotAdmin,
  BotLink,
  BotPoll,
  BotView,
  CascadesView,
  GClientDetail,
  GClientLive,
  GClientRow,
  GSyncState,
  NotifyEvents,
  PanelUpdateView,
  ServerDetail,
  ServerReach,
  ServerSummary,
  ServiceUpdate,
  Tag,
  WatchList,
  XrayStatus,
  XuiInboundRow,
} from '@vps/protocol';
import { DEVICES, actionTitle, deviceOf } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import QRCode from 'qrcode';
import type { Db } from '../db/index.js';
import { actionLog, servers, sessions } from '../db/schema.js';
import { deleteAllSessions, theAdmin, verifyTotp } from '../lib/auth.js';
import { newId } from '../lib/ids.js';
import { internalHeaders } from '../lib/internal-auth.js';
import { deleteSetting, getJsonSetting, getSetting, putSetting } from '../lib/settings.js';
import { esc } from '../lib/telegram.js';
import type { NotifyMeta, Telegram, TgApiResult } from '../lib/telegram.js';
import type { UiEvent } from '../lib/ui-hub.js';
import { ACTION_OPS, type ActionSpec, ApiError, type PanelApi, actionSpec } from './actions.js';
import {
  askDeviceName,
  askName,
  askType,
  clientView,
  clientsView,
  created,
  deviceView,
  devicesView,
  linksView,
  liveView,
  watchesView,
} from './client-views.js';
import { Refs, parseCb } from './codec.js';
import { type BotLevel, notifyButtons } from './notify-buttons.js';
import {
  backupView,
  notifyView,
  routeView,
  sessionsView,
  syncView,
  versionView,
} from './panel-views.js';
import {
  type AwgInstanceRow,
  type IpStep,
  askIp,
  awgUsersView,
  awgView,
  cascadesView,
  ipCheckView,
  mtView,
  ofView,
  serviceButtons,
  wdttView,
  xuiView,
} from './service-views.js';
import {
  type Btn,
  COMMANDS,
  type Ctx,
  I,
  MENU,
  MENU_KEYBOARD,
  OFF_TEXT,
  STALE_TEXT,
  type Screen,
  actionView,
  backupsView,
  bansView,
  codeView,
  confirmView,
  containerView,
  dockerView,
  findServers,
  journalView,
  logsView,
  maintenanceView,
  offConfirmView,
  planView,
  progressText,
  reachView,
  searchView,
  securityView,
  serverView,
  serversView,
  settingsView,
  summaryView,
  tagsView,
  welcomeText,
} from './views.js';

const ON_KEY = 'tg_bot_on';
const LEVEL_KEY = 'tg_bot_level';
/** Подтверждение и ввод кода 2FA ждут 2 минуты. */
const CONFIRM_TTL_MS = 2 * 60_000;

/** Неверных кодов подряд до блокировки действий и на сколько. */
const CODE_FAILS = 5;
const CODE_LOCK_MS = 15 * 60_000;
/** Ход действия правится не чаще. */
const PROGRESS_EDIT_MS = 15_000;
/** Последний экран из меню (одна "домашняя" плашка в чате вместо ленты экранов). */
const HOME_KEY = 'tg_bot_home';
/** Ссылки и конфиги клиентов удаляются из чата через 10 минут (решение Konan). */
const SECRET_TTL_MS = 10 * 60_000;
const DELETE_KEY = 'tg_bot_delete';
/** Мастер (новый клиент, устройство) забывается через 15 минут. */
const FLOW_TTL_MS = 15 * 60_000;
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
  entities?: unknown[];
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] };
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

export type BotTelegram = Pick<
  Telegram,
  'api' | 'settings' | 'health' | 'muteUntil' | 'sendDocument' | 'sendFile'
> & {
  chatsFromBot: Telegram['chatsFromBot'];
  buttons: Telegram['buttons'];
};

export interface BotDeps {
  db: Db;
  telegram: BotTelegram;
  /** запрос к API панели (app.inject): бот видит то же, что интерфейс */
  inject: (o: InjectOptions) => Promise<LightMyRequestResponse>;
  panelUrl: string;
  version: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** события действий: ход запущенного из бота */
  hub?: { listen: (fn: (ev: UiEvent) => void) => () => void };
}

class NotFound extends Error {}

/** Мастер: новый клиент или устройство; mid - сообщение, которое правится по шагам. */
interface Flow {
  kind: 'client' | 'device' | 'ip';
  step: 'name' | 'type' | 'device' | 'ip' | 'check';
  serverId?: string;
  chat: number;
  mid: number;
  clientId?: string;
  name?: string;
  type?: string;
  expires: number;
}

/** Сообщение со ссылками клиента: когда удалить. */
interface Pending {
  chat: string;
  id: number;
  at: number;
}

/** Ход действия, запущенного из бота: в каком сообщении он показывается. */
interface Tracked {
  chat: number | string;
  mid: number;
  header: string;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  spec: ActionSpec;
}

/** Как сообщение выглядело до действия: текст с разметкой и кнопки. */
interface Origin {
  text: string;
  entities: unknown[];
  kb: unknown;
  /** уведомление панели, а не экран бота */
  notify: boolean;
  at: number;
}

const cutText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);

/** Последняя содержательная строка вывода: причина ошибки без всего вывода. */
function lastLine(out: string): string {
  const lines = out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return cutText(lines.at(-1) ?? '', 300);
}

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
  private confirms = new Map<
    string,
    { op: string; args: string[]; data: string; expires: number }
  >();
  private origins = new Map<string, Origin>();
  private screenOf = new Map<string, string>();
  /** ждёт кода 2FA: подтверждение и сообщение, которое правится */
  private codeWait: { token: string; chat: number; mid: number; expires: number } | null = null;

  private codeFails = 0;
  private lockedUntil = 0;
  private usedCodes = new Map<string, number>();
  private tracked = new Map<string, Tracked>();
  /** мастер: новый клиент или устройство */
  private flow: Flow | null = null;
  private deleteTimer: NodeJS.Timeout | null = null;
  private unlisten: (() => void) | null = null;

  constructor(private deps: BotDeps) {
    deps.telegram.buttons = (m) => this.notifyMarkup(m);
  }

  level(): BotLevel {
    const v = getSetting(this.deps.db, LEVEL_KEY);
    return v === 'view' || v === 'safe' ? v : 'all';
  }

  setLevel(level: BotLevel) {
    putSetting(this.deps.db, LEVEL_KEY, level);
  }

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
    this.unlisten = this.deps.hub?.listen((ev) => this.onHub(ev)) ?? null;
    this.scheduleDeletes();
    void this.loop();
    return () => {
      this.running = false;
      this.unlisten?.();
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
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
    if (this.codeWait && /^\d{6}$/.test(text.replace(/\s+/g, ''))) {
      await this.send('deleteMessage', { chat_id: chat, message_id: m.message_id });
      return this.onCode(text.replace(/\s+/g, ''));
    }
    const cmd = text.replace(/@\w+$/, '').split(/\s/)[0] ?? '';
    if (cmd === '/cancel') {
      const w = this.codeWait;
      this.codeWait = null;
      if (w) await this.cancelIn(w.chat, w.mid);
      const f = this.flow;
      this.flow = null;
      if (f) await this.cancelIn(f.chat, f.mid);
      await this.send('deleteMessage', { chat_id: chat, message_id: m.message_id });
      return;
    }
    if (this.flow && Date.now() > this.flow.expires) this.flow = null;
    if (this.flow && text && !text.startsWith('/') && !Object.values(MENU).includes(text))
      return this.onFlowText(m, text);
    if (cmd === '/start') {
      await this.send('sendMessage', {
        chat_id: chat,
        text: 'Меню\u00a0\u2014 кнопками внизу',
        reply_markup: MENU_KEYBOARD,
      });
      return this.home(chat, m.message_id, 'm');
    }
    const menu: Record<string, string> = {
      '/menu': 'm',
      [MENU.summary]: 'm',
      '/servers': 'sl:-:0',
      [MENU.servers]: 'sl:-:0',
      '/clients': 'gl:0:0',
      [MENU.clients]: 'gl:0:0',
      '/log': 'lg:-:0',
      [MENU.log]: 'lg:-:0',
      '/settings': 'st',
      [MENU.more]: 'st',
    };
    const go = menu[cmd] ?? menu[text];
    if (go) return this.home(chat, m.message_id, go);
    if (text.startsWith('/'))
      return this.home(chat, m.message_id, '', {
        text: 'Команды: /menu, /servers, /clients, /log, /settings',
        kb: [],
      });
    if (!text) return;
    const [list, rows] = await Promise.all([
      this.get<ServerSummary[]>('/api/servers'),
      this.get<GClientRow[]>('/api/gclients'),
    ]);
    const found = findServers(list, text);
    const qq = text.toLocaleLowerCase('ru');
    const exact = rows.filter((r) => r.name.toLocaleLowerCase('ru') === qq);
    const clients = exact.length
      ? exact
      : rows.filter((r) => r.name.toLocaleLowerCase('ru').includes(qq));
    if (found.length === 1 && !clients.length && found[0])
      return this.home(chat, m.message_id, `sv:${found[0].id}`);
    if (clients.length === 1 && !found.length && clients[0])
      return this.home(chat, m.message_id, `gc:${clients[0].id}`);
    return this.home(chat, m.message_id, '', searchView(text, found, clients));
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
    await this.home(from.id, null, 'm');
  }

  /**
   * Экран из меню, команды или поиска - одна "домашняя" плашка в чате: прежняя удаляется
   * (если в ней не идёт действие или мастер), сообщение администратора тоже. data - чем
   * открыть экран заново; screen - готовый (поиск).
   */
  private async home(chat: number, userMid: number | null, data: string, screen?: Screen) {
    if (userMid) await this.send('deleteMessage', { chat_id: chat, message_id: userMid });
    let s: Screen | null | undefined = screen;
    if (!s) {
      const { op, args } = parseCb(data);
      s = await this.screen(op, args).catch((e) => {
        if (e instanceof NotFound) return null;
        throw e;
      });
    }
    if (!s) return;
    const prev = getJsonSetting<{ chat: string; id: number } | null>(this.deps.db, HOME_KEY, null);
    const busy =
      prev &&
      ([...this.tracked.values()].some((t) => t.mid === prev.id) ||
        this.flow?.mid === prev.id ||
        this.codeWait?.mid === prev.id ||
        this.origins.has(this.key(prev.chat, prev.id)));
    if (prev && prev.chat === String(chat) && !busy)
      await this.send('deleteMessage', { chat_id: chat, message_id: prev.id });
    const r = await this.reply(chat, s);
    const mid = r?.ok ? (r.result as { message_id?: number }).message_id : undefined;
    if (!mid) return;
    putSetting(this.deps.db, HOME_KEY, JSON.stringify({ chat: String(chat), id: mid }));
    if (data) this.rememberScreen(chat, mid, data);
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
    if (op === 'o') {
      // переход из уведомления - на месте, с кнопкой возврата к уведомлению
      const [sub = '', ...rest] = args;
      let screen: Screen | null = null;
      try {
        screen = await this.screen(sub, rest);
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
      }
      await answer(screen ? undefined : 'Не найдено: возможно, удалено');
      if (!screen) return;
      this.stash(msg);
      this.rememberScreen(msg.chat.id, msg.message_id, [sub, ...rest].join(':'));
      await this.paint(msg.chat.id, msg.message_id, screen);
      return;
    }
    if (op === 'ob') {
      await answer();
      this.screenOf.delete(this.key(msg.chat.id, msg.message_id));
      if (!(await this.restore(msg.chat.id, msg.message_id))) await answer(STALE_TEXT, true);
      return;
    }
    if (ACTION_OPS.has(op)) return this.onAction(q, msg, op, args, answer);
    if (op === 'cf') return this.onConfirm(msg, args[0] ?? '', answer);
    if (op === 'af') return this.outputFile(msg, args[0] ?? '', answer);
    if (op === 'gk' || op === 'gq' || op === 'ga') return this.secrets(msg, op, args, answer);
    if (op === 'nc' || op === 'nd' || op === 'fy' || op === 'fs' || op === 'fx')
      return this.onFlowButton(msg, op, args, answer);
    if (op === 'ic' || op === 'iy') return this.onIpButton(msg, op, args, answer);
    if (op === 'cx') {
      this.confirms.delete(args[0] ?? '');
      if (this.codeWait?.token === args[0]) this.codeWait = null;
      await answer();
      await this.cancelIn(msg.chat.id, msg.message_id);
      return;
    }
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
    let data = toast ? 'sl:-:0' : (q.data ?? '');
    if (!screen) {
      screen = await this.screen('m', []);
      data = 'm';
      toast = STALE_TEXT;
    }
    if (screen) {
      this.rememberScreen(msg.chat.id, msg.message_id, data);
      await this.edit(msg, screen);
    }
    await answer(toast);
  }

  // ---- действия ----

  /** API панели для действий: от имени бота (в журнале действий - "из Telegram"). */
  private api: PanelApi = {
    get: (url) => this.get(url),
    post: (url, body) => this.call('POST', url, body),
    put: (url, body) => this.call('PUT', url, body),
    patch: (url, body) => this.call('PATCH', url, body),
    delete: (url) => this.call('DELETE', url),
  };

  private async call<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.deps.inject({
      method,
      url,
      ...(method === 'DELETE'
        ? { headers: internalHeaders('telegram') }
        : {
            headers: { ...internalHeaders('telegram'), 'content-type': 'application/json' },
            payload: JSON.stringify(body ?? {}),
          }),
    });
    if (res.statusCode >= 400) {
      let msg = res.body.slice(0, 300);
      try {
        msg = (JSON.parse(res.body) as { error?: string }).error ?? msg;
      } catch {
        // ответ не JSON
      }
      throw new ApiError(res.statusCode, msg);
    }
    return (res.body ? res.json() : {}) as T;
  }

  /** Кнопки к уведомлению: только когда управление включено и аккаунт привязан. */
  private async notifyMarkup(m: NotifyMeta): Promise<unknown | null> {
    if (!this.isOn() || !this.admin()) return null;
    let providerUrl: string | undefined;
    if (m.serverId && (m.event === 'offline' || m.event === 'payment'))
      providerUrl =
        this.deps.db
          .select({ url: servers.providerUrl })
          .from(servers)
          .where(eq(servers.id, m.serverId))
          .get()?.url ?? undefined;
    const kb = notifyButtons({ ...m, providerUrl }, this.level(), (v) => this.refs.put(v));
    return kb.length ? this.markup({ text: '', kb }) : null;
  }

  private allowed(risk: ActionSpec['risk']): string | null {
    const lv = this.level();
    if (lv === 'view')
      return 'Действия выключены: в настройках бота уровень \u00abтолько просмотр\u00bb';
    if (lv === 'safe' && risk !== 'safe')
      return 'Это действие выключено: в настройках бота уровень \u00abбезопасные действия\u00bb';
    return null;
  }

  private specDeps() {
    return {
      api: this.api,
      refValue: (k: string) => this.refs.get(k),
      muteUntil: (id: string, until: Date) => this.deps.telegram.muteUntil(id, until),
      logoutAll: async () => {
        const a = await theAdmin(this.deps.db);
        if (!a) return 0;
        const n = this.deps.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.adminId, a.id))
          .all().length;
        await deleteAllSessions(this.deps.db, a.id);
        return n;
      },
      now: () => Date.now(),
    };
  }

  /** Убрать нажатую кнопку из сообщения: действие уже не нужно. */
  private async dropButton(msg: TgMessage, data: string) {
    const rows = msg.reply_markup?.inline_keyboard;
    if (!rows) return;
    const left = rows.map((r) => r.filter((b) => b.callback_data !== data)).filter((r) => r.length);
    await this.send('editMessageReplyMarkup', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: left },
    });
  }

  // ---- одно сообщение на дело: подтверждение, ход и итог - на месте нажатого ----

  private key(chat: number | string, mid: number): string {
    return `${chat}:${mid}`;
  }

  /**
   * Запомнить, как сообщение выглядело до действия (уведомление или экран): "Отмена" и "Назад"
   * возвращают его. notify - сообщение не экран бота (уведомление панели).
   */
  private stash(msg: TgMessage) {
    const k = this.key(msg.chat.id, msg.message_id);
    if (this.origins.has(k)) return;
    this.origins.set(k, {
      text: msg.text ?? '',
      entities: msg.entities ?? [],
      kb: msg.reply_markup ?? { inline_keyboard: [] },
      notify: !this.screenOf.has(k),
      at: Date.now(),
    });
    while (this.origins.size > 300) {
      const first = this.origins.keys().next().value;
      if (first === undefined) break;
      this.origins.delete(first);
    }
  }

  /** Вернуть сообщению прежний вид; drop - без кнопки с этими данными. */
  private async restore(chat: number | string, mid: number, drop?: string): Promise<boolean> {
    const k = this.key(chat, mid);
    const o = this.origins.get(k);
    if (!o) return false;
    this.origins.delete(k);
    const kb = o.kb as { inline_keyboard?: { callback_data?: string }[][] };
    const rows = (kb.inline_keyboard ?? [])
      .map((r) => r.filter((b) => !drop || b.callback_data !== drop))
      .filter((r) => r.length);
    await this.send('editMessageText', {
      chat_id: chat,
      message_id: mid,
      text: o.text,
      entities: o.entities,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: rows },
    });
    return true;
  }

  /** Экран бота в сообщении: каким нажатием он открыт (для "Назад" и повтора). */
  private rememberScreen(chat: number | string, mid: number, data: string) {
    const k = this.key(chat, mid);
    this.screenOf.delete(k);
    this.screenOf.set(k, data);
    while (this.screenOf.size > 500) {
      const first = this.screenOf.keys().next().value;
      if (first === undefined) break;
      this.screenOf.delete(first);
    }
  }

  /** Кнопки возврата под итогом: к экрану, с которого начали, и к уведомлению. */
  private backRows(chat: number | string, mid: number): Btn[][] {
    const k = this.key(chat, mid);
    const rows: Btn[][] = [];
    const scr = this.screenOf.get(k);
    if (scr) rows.push([{ text: `${I.back} Назад`, data: scr }]);
    if (this.origins.get(k)?.notify) rows.push([{ text: `${I.back} К уведомлению`, data: 'ob' }]);
    return rows;
  }

  /** "Отмена": экран - открыть заново, уведомление - вернуть как было. */
  private async cancelIn(chat: number | string, mid: number) {
    const scr = this.screenOf.get(this.key(chat, mid));
    if (scr) {
      const { op, args } = parseCb(scr);
      const s = await this.screen(op, args).catch(() => null);
      if (s) {
        await this.paint(chat, mid, s);
        return;
      }
    }
    if (!(await this.restore(chat, mid)))
      await this.send('deleteMessage', { chat_id: chat, message_id: mid });
  }

  /** Экран на месте сообщения; если оно было уведомлением - с кнопкой возврата к нему. */
  private paint(chat: number | string, mid: number, s: Screen) {
    const notify = this.origins.get(this.key(chat, mid))?.notify;
    const kb = notify ? [...s.kb, [{ text: `${I.back} К уведомлению`, data: 'ob' }]] : s.kb;
    return this.editText(chat, mid, s.text, { text: s.text, kb });
  }

  private async onAction(
    q: TgCallback,
    msg: TgMessage,
    op: string,
    args: string[],
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    let spec: ActionSpec | null;
    try {
      spec = await actionSpec(op, args, this.specDeps());
    } catch (e) {
      await answer(
        e instanceof ApiError && e.status === 404
          ? 'Не найдено: возможно, удалено'
          : (e as Error).message,
        true,
      );
      return;
    }
    if (!spec) return answer(STALE_TEXT, true);
    const no = this.allowed(spec.risk);
    if (no) return answer(no, true);
    if (spec.stale) {
      await answer(spec.stale, true);
      await this.dropButton(msg, q.data ?? '');
      return;
    }
    this.stash(msg);
    if (spec.risk === 'safe') {
      await this.execute(spec, msg.chat.id, msg.message_id, q.data ?? '', answer);
      return;
    }
    const token = this.refs.put(JSON.stringify({ op, args, n: Math.random() }));
    this.confirms.set(token, {
      op,
      args,
      data: q.data ?? '',
      expires: Date.now() + CONFIRM_TTL_MS,
    });
    await answer();
    const v = confirmView(spec.question, spec.verb, token);
    await this.editText(msg.chat.id, msg.message_id, v.text, v);
  }

  private async onConfirm(
    msg: TgMessage,
    token: string,
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const chat = msg.chat.id;
    const c = this.confirms.get(token);
    if (!c || Date.now() > c.expires) {
      this.confirms.delete(token);
      await answer('Подтверждение устарело, нажмите кнопку действия ещё раз', true);
      await this.cancelIn(chat, msg.message_id);
      return;
    }
    let spec: ActionSpec | null;
    try {
      spec = await actionSpec(c.op, c.args, this.specDeps());
    } catch (e) {
      return answer((e as Error).message, true);
    }
    if (!spec) return answer(STALE_TEXT, true);
    const no = this.allowed(spec.risk);
    if (no) return answer(no, true);
    if (spec.stale) {
      this.confirms.delete(token);
      await answer(spec.stale, true);
      await this.restore(chat, msg.message_id, c.data);
      return;
    }
    if (spec.risk === 'code') {
      if (Date.now() < this.lockedUntil)
        return answer('Слишком много неверных кодов: действия недоступны 15 минут', true);
      const admin = await theAdmin(this.deps.db);
      if (!admin?.totpEnabled || !admin.totpSecret)
        return answer('Двухфакторная аутентификация не настроена: войдите в панель', true);
      c.expires = Date.now() + CONFIRM_TTL_MS;
      this.codeWait = { token, chat, mid: msg.message_id, expires: c.expires };
      await answer();
      const v = codeView(spec.question, token);
      await this.editText(chat, msg.message_id, v.text, v);
      return;
    }
    this.confirms.delete(token);
    await this.execute(spec, chat, msg.message_id, c.data, answer);
  }

  /** Код 2FA сообщением (удаление сервера): верный - действие, неверный - счётчик попыток. */
  private async onCode(code: string) {
    const w = this.codeWait;
    if (!w) return;
    const c = this.confirms.get(w.token);
    if (!c || Date.now() > w.expires) {
      this.codeWait = null;
      await this.cancelIn(w.chat, w.mid);
      return;
    }
    const admin = await theAdmin(this.deps.db);
    const now = Date.now();
    for (const [k, at] of this.usedCodes) if (now - at > 120_000) this.usedCodes.delete(k);
    const ok =
      Boolean(admin?.totpSecret) &&
      !this.usedCodes.has(code) &&
      verifyTotp(admin?.totpSecret ?? '', code);
    const spec = await actionSpec(c.op, c.args, this.specDeps()).catch(() => null);
    if (!ok) {
      this.codeFails++;
      if (this.codeFails >= CODE_FAILS) {
        this.codeFails = 0;
        this.lockedUntil = now + CODE_LOCK_MS;
        this.codeWait = null;
        this.confirms.delete(w.token);
        this.deps.log.warn({}, 'бот: неверные коды 2FA, действия заблокированы на 15 минут');
        await this.editText(
          w.chat,
          w.mid,
          'Неверный код. Действия через бота недоступны 15\u00a0минут',
          { text: '', kb: this.backRows(w.chat, w.mid) },
        );
        return;
      }
      const left = CODE_FAILS - this.codeFails;
      const v = codeView(spec?.question ?? '', w.token, `Неверный код, попыток: ${left}`);
      await this.editText(w.chat, w.mid, v.text, v);
      return;
    }
    this.usedCodes.set(code, now);
    this.codeFails = 0;
    this.codeWait = null;
    this.confirms.delete(w.token);
    if (!spec || spec.stale) {
      await this.cancelIn(w.chat, w.mid);
      return;
    }
    await this.execute(spec, w.chat, w.mid, c.data);
  }

  /**
   * Выполнить действие в сообщении mid (уведомление, экран или подтверждение на их месте).
   * Короткий итог - всплывающим сообщением, если успели ответить на нажатие; длинное действие -
   * "идёт" с временем, по окончании - итог на месте. pressed - данные нажатой кнопки (её
   * снимают, когда действие больше не нужно).
   */
  private async execute(
    spec: ActionSpec,
    chat: number | string,
    mid: number,
    pressed: string,
    answer?: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const header = spec.serverName
      ? `<b>${esc(spec.serverName)}</b>: ${esc(spec.title)}`
      : `<b>${esc(spec.title[0]?.toUpperCase() ?? '')}${esc(spec.title.slice(1))}</b>`;
    let answered = !answer;
    const ack = async (text?: string, alert = false): Promise<boolean> => {
      if (answered) return false;
      answered = true;
      await answer?.(text, alert);
      return true;
    };
    // Telegram ждёт ответа на нажатие недолго: долгое действие - сначала "идёт"
    const slow = setTimeout(() => {
      void ack();
      void this.editText(chat, mid, progressText(header, Date.now(), Date.now()));
    }, 4_000);
    slow.unref?.();
    let res: Awaited<ReturnType<ActionSpec['run']>>;
    try {
      res = await spec.run();
    } catch (e) {
      clearTimeout(slow);
      const m =
        e instanceof ApiError && e.status === 409
          ? `сервер занят: ${e.message}`
          : (e as Error).message;
      if (!(await ack(cutText(m, 190), true)))
        await this.editText(chat, mid, `${I.fail} ${header}: ${esc(m)}`, {
          text: '',
          kb: this.backRows(chat, mid),
        });
      else await this.cancelIn(chat, mid);
      return;
    }
    clearTimeout(slow);
    if ('toast' in res) {
      const shown = await ack(res.toast);
      if (res.reopen) {
        const s = await this.screen(res.reopen.op, res.reopen.args).catch(() => null);
        if (s) {
          this.rememberScreen(chat, mid, [res.reopen.op, ...res.reopen.args].join(':'));
          await this.paint(chat, mid, s);
        }
      } else if (!(await this.restore(chat, mid, res.drop ? pressed : undefined)) && !shown)
        await this.editText(chat, mid, esc(res.toast));
      if (!shown && res.reopen)
        await this.send('sendChatAction', { chat_id: chat, action: 'typing' });
      return;
    }
    await ack();
    if ('screen' in res) {
      await this.paint(chat, mid, res.screen);
      return;
    }
    if ('reopen' in res) {
      const sc = await this.screen(res.reopen.op, res.reopen.args).catch(() => null);
      if (sc) {
        this.rememberScreen(chat, mid, [res.reopen.op, ...res.reopen.args].join(':'));
        await this.paint(chat, mid, sc);
      }
      return;
    }
    if ('text' in res) {
      await this.settle(chat, mid, res.text, res.kb ?? []);
      return;
    }
    const startedAt = Date.now();
    await this.editText(chat, mid, progressText(header, startedAt, startedAt));
    const t: Tracked = { chat, mid, header, startedAt, timer: null, spec };
    // раз в 15 секунд - сколько идёт: видно, что не зависло
    t.timer = setInterval(() => {
      void this.editText(chat, mid, progressText(header, startedAt, Date.now()));
    }, PROGRESS_EDIT_MS);
    t.timer.unref?.();
    this.tracked.set(res.actionId, t);
    // короткое действие могло закончиться раньше, чем бот начал следить
    const row = await this.get<ActionListRow & { output: string }>(
      `/api/actions/${res.actionId}`,
    ).catch(() => null);
    if (row?.finishedAt) await this.finishTracked(res.actionId);
  }

  /**
   * Успешный итог на месте сообщения. Уведомление становится итогом (возврат к нему не нужен),
   * экран - итогом с кнопкой "Назад".
   */
  private async settle(chat: number | string, mid: number, text: string, kb: Btn[][]) {
    const k = this.key(chat, mid);
    const onScreen = this.screenOf.has(k);
    if (!onScreen) this.origins.delete(k);
    const rows = [...kb, ...(onScreen ? this.backRows(chat, mid) : [])];
    if (onScreen) this.origins.delete(k);
    await this.editText(chat, mid, text, { text, kb: rows });
  }

  /** Вывод действия целиком - файлом в чат. */
  private async outputFile(
    msg: TgMessage,
    id: string,
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const a = await this.get<ActionListRow & { output: string }>(
      `/api/actions/${encodeURIComponent(id)}`,
    ).catch(() => null);
    if (!a) return answer('Действие не найдено', true);
    await answer();
    const err = await this.deps.telegram.sendDocument(
      `action-${a.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.txt`,
      Buffer.from(a.output, 'utf8'),
      esc(actionTitle(a.kind, a.params)),
      String(msg.chat.id),
    );
    if (err) await answer(err, true);
  }

  private onHub(ev: UiEvent) {
    if (ev.type !== 'action.finished') return;
    if (this.tracked.has(ev.actionId)) void this.finishTracked(ev.actionId);
  }

  private async finishTracked(actionId: string) {
    const t = this.tracked.get(actionId);
    if (!t) return;
    this.tracked.delete(actionId);
    if (t.timer) clearInterval(t.timer);
    const a = await this.get<ActionListRow & { output: string }>(`/api/actions/${actionId}`).catch(
      () => null,
    );
    if (!a) return;
    const ok = a.exitCode === 0;
    const extra = (await t.spec.after?.(ok).catch(() => [])) ?? [];
    if (ok) {
      await this.settle(t.chat, t.mid, `${I.done} ${t.spec.done ?? `${t.header}: готово`}`, extra);
      return;
    }
    const why = lastLine(a.output);
    const text = `${I.fail} ${t.header}: ошибка${a.exitCode !== null ? `, код ${a.exitCode}` : ''}${why ? `\n<i>${esc(why)}</i>` : ''}`;
    await this.editText(t.chat, t.mid, text, {
      text,
      kb: [
        ...extra,
        [{ text: 'Вывод файлом', data: `af:${actionId}` }],
        ...this.backRows(t.chat, t.mid),
      ],
    });
  }

  // ---- ссылки и конфиги клиентов: удаляются из чата через 10 минут ----

  private async secrets(
    msg: TgMessage,
    op: string,
    args: string[],
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const g = await this.get<GClientDetail>(
      `/api/gclients/${encodeURIComponent(args[0] ?? '')}`,
    ).catch(() => null);
    if (!g) return answer('Клиент не найден', true);
    const chat = msg.chat.id;
    if (op === 'gk') {
      await answer();
      const r = await this.reply(chat, linksView(g), msg.message_id);
      if (r?.ok) this.forgetLater(chat, (r.result as { message_id: number }).message_id);
      return;
    }
    if (op === 'gq') {
      await answer();
      const png = await QRCode.toBuffer(g.subscription.url, { margin: 2, width: 720 });
      const r = await this.deps.telegram.sendFile(
        'photo',
        'subscription.png',
        png,
        `<b>${esc(g.client.name)}</b>: QR подписки (удалится через 10 мин)`,
        String(chat),
      );
      if (r.messageId) this.forgetLater(chat, r.messageId);
      else if (r.err)
        await this.reply(chat, { text: `\u274c ${esc(r.err)}`, kb: [] }, msg.message_id);
      return;
    }
    // ga: .conf AWG по привязке устройства - тот же файл, что на личной странице
    const b = g.bindings.find((x) => x.id === args[1] && x.service === 'awg');
    if (!b) return answer('Привязка не найдена', true);
    const res = await this.deps.inject({
      method: 'GET',
      url: `/c/${encodeURIComponent(g.client.token)}/awg/${encodeURIComponent(b.id)}/conf`,
    });
    if (res.statusCode !== 200) return answer('Конфиг недоступен: у привязки нет ключа', true);
    await answer();
    const dev = g.devices.find((x) => x.id === b.deviceId);
    const name =
      /filename="([^"]+)"/.exec(String(res.headers['content-disposition'] ?? ''))?.[1] ??
      'awg.conf';
    const who = dev ? `, ${esc(dev.name || deviceOf(dev.type)?.title || '')}` : '';
    const r = await this.deps.telegram.sendFile(
      'document',
      name,
      Buffer.from(res.body, 'utf8'),
      `<b>${esc(g.client.name)}</b>${who}: AWG ${esc(b.serverName)} (удалится через 10 мин)`,
      String(chat),
    );
    if (r.messageId) this.forgetLater(chat, r.messageId);
    else if (r.err)
      await this.reply(chat, { text: `\u274c ${esc(r.err)}`, kb: [] }, msg.message_id);
  }

  /** Удалить сообщение через 10 минут; очередь в базе переживает перезапуск панели. */
  private forgetLater(chat: number | string, id: number) {
    const list = getJsonSetting<Pending[]>(this.deps.db, DELETE_KEY, []);
    list.push({ chat: String(chat), id, at: Date.now() + SECRET_TTL_MS });
    putSetting(this.deps.db, DELETE_KEY, JSON.stringify(list.slice(-200)));
    this.scheduleDeletes();
  }

  private scheduleDeletes() {
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    const list = getJsonSetting<Pending[]>(this.deps.db, DELETE_KEY, []);
    if (!list.length) return;
    const next = Math.min(...list.map((x) => x.at));
    this.deleteTimer = setTimeout(() => void this.runDeletes(), Math.max(1_000, next - Date.now()));
    this.deleteTimer.unref?.();
  }

  private async runDeletes() {
    const now = Date.now();
    const list = getJsonSetting<Pending[]>(this.deps.db, DELETE_KEY, []);
    putSetting(this.deps.db, DELETE_KEY, JSON.stringify(list.filter((x) => x.at > now)));
    for (const x of list.filter((v) => v.at <= now))
      await this.send('deleteMessage', { chat_id: x.chat, message_id: x.id });
    this.scheduleDeletes();
  }

  // ---- мастера: новый клиент, новое устройство ----

  private async onFlowButton(
    msg: TgMessage,
    op: string,
    args: string[],
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const chat = msg.chat.id;
    if (op === 'nc' || op === 'nd') {
      const no = this.allowed('change');
      if (no) return answer(no, true);
      await answer();
      const now = Date.now();
      // мастер - на месте экрана, "Отмена" возвращает его
      const mid = msg.message_id;
      this.stash(msg);
      if (op === 'nc') {
        const v = askName();
        await this.editText(chat, mid, v.text, v);
        this.flow = { kind: 'client', step: 'name', chat, mid, expires: now + FLOW_TTL_MS };
        return;
      }
      const g = await this.get<GClientDetail>(
        `/api/gclients/${encodeURIComponent(args[0] ?? '')}`,
      ).catch(() => null);
      if (!g) return;
      const v = askType('Новое устройство', g.client.name);
      await this.editText(chat, mid, v.text, v);
      this.flow = {
        kind: 'device',
        step: 'type',
        chat,
        mid,
        clientId: g.client.id,
        name: g.client.name,
        expires: now + FLOW_TTL_MS,
      };
      return;
    }
    const f = this.flow;
    if (!f || f.mid !== msg.message_id || Date.now() > f.expires) {
      this.flow = null;
      await answer(STALE_TEXT, true);
      return;
    }
    await answer();
    if (op === 'fx') {
      this.flow = null;
      await this.cancelIn(chat, f.mid);
      return;
    }
    if (op === 'fy' && f.step === 'type') {
      const type = args[0] ?? '-';
      if (type === '-') {
        // клиент без устройств: VLESS, MTProxy и WDTT у него всё равно будут
        if (f.kind === 'client') return this.finishFlow(f, null);
        this.flow = null;
        await this.editText(chat, f.mid, 'Отменено');
        return;
      }
      if (!DEVICES.some((d) => d.id === type)) return;
      f.type = type;
      f.step = 'device';
      const v = askDeviceName(
        f.kind === 'client' ? 'Новый клиент' : 'Новое устройство',
        deviceOf(type)?.title ?? type,
      );
      await this.editText(chat, f.mid, v.text, v);
      return;
    }
    if (op === 'fs' && f.step === 'device') return this.finishFlow(f, '');
  }

  private async onFlowText(m: TgMessage, text: string) {
    const f = this.flow;
    if (!f) return;
    await this.send('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id });
    if (f.kind === 'ip' && f.serverId) return this.ipCheck(f, text.trim());
    if (f.step === 'name' && f.kind === 'client') {
      f.name = text.slice(0, 64);
      f.step = 'type';
      const v = askType('Новый клиент', f.name);
      await this.editText(f.chat, f.mid, v.text, v);
      return;
    }
    if (f.step === 'device') return this.finishFlow(f, text.slice(0, 64));
  }

  private async finishFlow(f: Flow, deviceName: string | null) {
    this.flow = null;
    this.origins.delete(this.key(f.chat, f.mid));
    const device =
      f.type && deviceName !== null ? { name: deviceName, type: f.type, awg20: false } : null;
    try {
      if (f.kind === 'client') {
        const r = await this.api.post<{ id: string }>('/api/gclients', {
          name: f.name ?? '',
          devices: device ? [device] : [],
          access: null,
        });
        const v = created(f.name ?? '', r.id);
        await this.editText(f.chat, f.mid, v.text, v);
        return;
      }
      if (!device || !f.clientId) return;
      await this.api.post(`/api/gclients/${encodeURIComponent(f.clientId)}/devices`, device);
      const v = await this.screen('gd', [f.clientId]);
      if (v) await this.editText(f.chat, f.mid, v.text, v);
    } catch (e) {
      await this.editText(f.chat, f.mid, `\u274c ${esc((e as Error).message)}`);
    }
  }

  // ---- смена IP: адрес сообщением, проверка, переключение (опасное, с подтверждением) ----

  private async onIpButton(
    msg: TgMessage,
    op: string,
    args: string[],
    answer: (text?: string, alert?: boolean) => Promise<TgApiResult>,
  ) {
    const no = this.allowed('danger');
    if (no) return answer(no, true);
    if (op === 'ic') {
      const s = await this.get<ServerDetail>(
        `/api/servers/${encodeURIComponent(args[0] ?? '')}`,
      ).catch(() => null);
      if (!s) return answer('Сервер не найден', true);
      await answer();
      const mid = msg.message_id;
      this.stash(msg);
      const v = askIp(s);
      await this.editText(msg.chat.id, mid, v.text, v);
      this.flow = {
        kind: 'ip',
        step: 'ip',
        serverId: s.id,
        chat: msg.chat.id,
        mid,
        expires: Date.now() + FLOW_TTL_MS,
      };
      return;
    }
    const raw = this.refs.get(args[0] ?? '');
    if (!raw) return answer(STALE_TEXT, true);
    const r = JSON.parse(raw) as { sid: string; ip: string };
    await answer();
    await this.ipCheck(
      {
        kind: 'ip',
        step: 'check',
        serverId: r.sid,
        chat: msg.chat.id,
        mid: msg.message_id,
        expires: Date.now() + FLOW_TTL_MS,
      },
      r.ip,
    );
  }

  private async ipCheck(f: Flow, ip: string) {
    const sid = f.serverId ?? '';
    const s = await this.get<ServerDetail>(`/api/servers/${encodeURIComponent(sid)}`).catch(
      () => null,
    );
    if (!s) return;
    this.flow = { ...f, step: 'check', expires: Date.now() + FLOW_TTL_MS };
    try {
      const r = await this.api.post<{ steps: IpStep[]; canSwitch: boolean }>(
        `/api/servers/${encodeURIComponent(sid)}/ip-change/check`,
        { ip },
      );
      const v = ipCheckView(
        s,
        ip,
        r.steps,
        r.canSwitch,
        this.refs.put(JSON.stringify({ sid, ip })),
      );
      await this.editText(f.chat, f.mid, v.text, v);
    } catch (e) {
      const v = askIp(s);
      await this.editText(f.chat, f.mid, `${v.text}\n\n\u274c ${esc((e as Error).message)}`, v);
      this.flow = { ...f, step: 'ip' };
    }
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
        return serverView({ s, reach, updates, services: serviceButtons(s) }, c);
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
      case 'gl':
        return clientsView(await this.get<GClientRow[]>('/api/gclients'), {
          page: Number(args[0]) || 0,
          problems: args[1] === '1',
        });
      case 'gc': {
        const id = encodeURIComponent(args[0] ?? '');
        const [g, w] = await Promise.all([
          this.get<GClientDetail>(`/api/gclients/${id}`),
          this.get<WatchList>('/api/watch'),
        ]);
        return clientView(
          g,
          w.rules.filter((r) => r.clientId === g.client.id),
          c,
        );
      }
      case 'gd':
        return devicesView(
          await this.get<GClientDetail>(`/api/gclients/${encodeURIComponent(args[0] ?? '')}`),
        );
      case 'gv': {
        const v = deviceView(
          await this.get<GClientDetail>(`/api/gclients/${encodeURIComponent(args[0] ?? '')}`),
          args[1] ?? '',
        );
        if (!v) throw new NotFound(args[1] ?? '');
        return v;
      }
      case 'gn': {
        const id = encodeURIComponent(args[0] ?? '');
        const g = await this.get<GClientDetail>(`/api/gclients/${id}`);
        const live = await this.get<GClientLive>(`/api/gclients/${id}/live`);
        return liveView(g, live, c);
      }
      case 'gw': {
        const id = encodeURIComponent(args[0] ?? '');
        const [g, w] = await Promise.all([
          this.get<GClientDetail>(`/api/gclients/${id}`),
          this.get<WatchList>('/api/watch'),
        ]);
        return watchesView(
          g,
          w.rules.filter((r) => r.clientId === g.client.id),
        );
      }
      case 'xu': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        const [info, inbounds, updates] = await Promise.all([
          this.get<{ active?: boolean; version?: string }>(`/api/servers/${id}/xui`).catch(
            () => null,
          ),
          this.get<XuiInboundRow[]>(`/api/servers/${id}/xui/inbound-list`).catch(() => []),
          this.get<ServiceUpdate[]>(`/api/servers/${id}/updates`).catch(() => []),
        ]);
        return xuiView(s, info, inbounds, updates);
      }
      case 'mp': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        const [st, updates] = await Promise.all([
          this.get<Parameters<typeof mtView>[1]>(`/api/servers/${id}/mtproxyl`).catch(() => null),
          this.get<ServiceUpdate[]>(`/api/servers/${id}/updates`).catch(() => []),
        ]);
        return mtView(s, st, updates);
      }
      case 'aw':
      case 'ai': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        const st = await this.get<{ instances?: AwgInstanceRow[] }>(`/api/servers/${id}/awg`).catch(
          () => null,
        );
        if (op === 'aw') return awgView(s, st, c);
        const inst = st?.instances?.[Number(args[1]) || 0];
        if (!inst) throw new NotFound(args[1] ?? '');
        return awgUsersView(s, inst, Number(args[1]) || 0, Number(args[2]) || 0, c);
      }
      case 'wd': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        return wdttView(
          s,
          await this.get<Parameters<typeof wdttView>[1]>(`/api/servers/${id}/wdtt`).catch(
            () => null,
          ),
          c,
        );
      }
      case 'of': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        return ofView(
          s,
          await this.get<Parameters<typeof ofView>[1]>(`/api/servers/${id}/openflux`).catch(
            () => null,
          ),
        );
      }
      case 'cs': {
        const id = encodeURIComponent(args[0] ?? '');
        const [s, v] = await Promise.all([
          this.get<ServerDetail>(`/api/servers/${id}`),
          this.get<CascadesView>(`/api/servers/${id}/cascades`),
        ]);
        return cascadesView(s, v, c);
      }
      case 'vs':
        return versionView(await this.get<PanelUpdateView>('/api/panel/update'), c);
      case 'pb':
        return backupView(await this.get<Parameters<typeof backupView>[0]>('/api/panel-backup'), c);
      case 'ns': {
        const t = await this.get<{ events: NotifyEvents }>('/api/notify/telegram');
        return notifyView(t.events);
      }
      case 'sy':
        return syncView(await this.get<GSyncState>('/api/gclients/syncing'), c);
      case 'tr':
        return routeView(await this.get<XrayStatus>('/api/xray'), this.deps.telegram.health(), c);
      case 'ss':
        return sessionsView(await this.get<Parameters<typeof sessionsView>[0]>('/api/security'), c);
      case 'mt': {
        const id = encodeURIComponent(args[0] ?? '');
        const [s, updates] = await Promise.all([
          this.get<ServerDetail>(`/api/servers/${id}`),
          this.get<ServiceUpdate[]>(`/api/servers/${id}/updates`),
        ]);
        return maintenanceView({ s, updates });
      }
      case 'sc':
        return securityView(
          await this.get<ServerDetail>(`/api/servers/${encodeURIComponent(args[0] ?? '')}`),
        );
      case 'dk':
        return dockerView(
          await this.get<ServerDetail>(`/api/servers/${encodeURIComponent(args[0] ?? '')}`),
        );
      case 'dc': {
        const s = await this.get<ServerDetail>(`/api/servers/${encodeURIComponent(args[0] ?? '')}`);
        const v = containerView(s, args[1] ?? '');
        if (!v) throw new NotFound(args[1] ?? '');
        return v;
      }
      case 'dl': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        const ct = s.inventory?.containers.find((x) => x.id === args[1]);
        if (!ct) throw new NotFound(args[1] ?? '');
        const r = await this.get<{ text: string }>(
          `/api/servers/${id}/docker/${encodeURIComponent(ct.id)}/logs?tail=80`,
        );
        return logsView(s, ct, r.text ?? '');
      }
      case 'bk': {
        const [s, list] = await Promise.all([
          this.get<ServerDetail>(`/api/servers/${encodeURIComponent(args[0] ?? '')}`),
          this.get<BackupInfo[]>('/api/backups'),
        ]);
        return backupsView(s, list, c);
      }
      case 'bn':
        return bansView(
          await this.get<ServerDetail>(`/api/servers/${encodeURIComponent(args[0] ?? '')}`),
          c,
        );
      case 'pl': {
        const id = encodeURIComponent(args[0] ?? '');
        const s = await this.get<ServerDetail>(`/api/servers/${id}`);
        const plan = await this.api.post<BaselinePlan>(`/api/servers/${id}/baseline/plan`);
        return planView(s, plan, c);
      }
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
          b.url
            ? { text: b.text, url: b.url }
            : b.copy
              ? { text: b.text, copy_text: { text: b.copy } }
              : { text: b.text, callback_data: b.data ?? 'noop' },
        ),
      ),
    };
  }

  private reply(chat: number | string, s: Screen | null, replyTo?: number) {
    if (!s) return Promise.resolve(null);
    return this.send('sendMessage', {
      chat_id: chat,
      text: s.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.markup(s),
      ...(replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {}),
    });
  }

  private editText(chat: number | string, mid: number, text: string, s?: Screen) {
    return this.send('editMessageText', {
      chat_id: chat,
      message_id: mid,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: s ? this.markup(s) : { inline_keyboard: [] },
    });
  }

  /** Экран на месте нажатого сообщения; править нельзя (удалено, слишком старое) - новым. */
  private async edit(msg: TgMessage, s: Screen) {
    const r = await this.paint(msg.chat.id, msg.message_id, s);
    if (!r.ok && !notModified(r) && r.status === 400) await this.reply(msg.chat.id, s);
  }
}
