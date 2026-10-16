import { randomBytes } from 'node:crypto';
import {
  NOTIFY_DEFAULTS,
  NOTIFY_PARAM_DEFAULTS,
  NOTIFY_PARAM_LIMITS,
  type NotifyEvent,
  type NotifyEvents,
  type NotifyParams,
  type TgHealth,
  type TgHealthView,
  readNotifyEvents,
} from '@vps/protocol';
import { ProxyAgent, fetch as ufetch } from 'undici';
import { AGENT_OUTDATED, type AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, putSetting } from './settings.js';
import type { XrayRoute } from './xray.js';

/** Методы Bot API, которые зовёт панель (getMe - проверка доставки). */
type TgMethod = 'sendMessage' | 'getUpdates' | 'getMe';

/** Настройки Telegram в таблице setting (ключ tg_*). */
export interface TgSettings extends NotifyParams {
  token: string;
  chatId: string;
  /** Включённые события (каталог - NOTIFY_EVENTS). */
  events: NotifyEvents;
  /** Серверы, о которых не уведомлять совсем (тестовые, выводимые из работы). */
  mutedServers: string[];
}

export const defaultTg: TgSettings = {
  token: '',
  chatId: '',
  events: { ...NOTIFY_DEFAULTS },
  mutedServers: [],
  ...NOTIFY_PARAM_DEFAULTS,
};

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgMsg {
  chat: TgChat;
  date: number;
}

/** Недоставленное сообщение: уйдёт после восстановления. */
interface Pending {
  at: string;
  text: string;
}

const HEALTH_KEY = 'tg_health';
const PENDING_KEY = 'tg_pending';
/** Сколько недоставленных сообщений хранить (старые вытесняются). */
const PENDING_MAX = 30;
const emptyHealth: TgHealth = {
  ok: null,
  failingSince: null,
  lastOkAt: null,
  lastOkVia: null,
  lastError: null,
  checkedAt: null,
};

/** Время для текста сообщений: интерфейс и владелец - по Москве. */
export function tgTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Telegram Bot API: настройки бота (token, chat id, события) и доставка - выходы xray, прокси из
 * окружения, напрямую, через агентов на серверах. Недоставленное копится и уходит после
 * восстановления со сводкой.
 */
export class Telegram {
  /** Сообщения уходят по одному, в порядке вызова: цепочка отправок. */
  private chain: Promise<unknown> = Promise.resolve();

  private envProxy: ProxyAgent | null;
  /** Последняя успешная доставка: каким путём и когда (для настроек). */
  lastRoute: { via: string; at: string } | null = null;
  private healthState: TgHealth;

  constructor(
    private db: Db,
    /** Токен бота хранится зашифрованным, как пароли в "Доступах". */
    private box: SecretBox,
    private registry: AgentRegistry,
    private log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
    /** Выходы xray по порядку (пусто, если xray не запущен) и отметка "через этот дошло". */
    private xray: { routes: () => XrayRoute[]; worked: (serverId: string) => void } = {
      routes: () => [],
      worked: () => {},
    },
    envProxyUrl = '',
  ) {
    this.envProxy = envProxyUrl ? new ProxyAgent(envProxyUrl) : null;
    this.healthState = { ...emptyHealth, ...getJsonSetting<TgHealth>(db, HEALTH_KEY, emptyHealth) };
  }

  /** Прокси по порядку: выходы xray, затем прокси из окружения. */
  private proxies(): { via: string; dispatcher: ProxyAgent }[] {
    return [
      ...this.xray.routes().map((r) => ({ via: `proxy:${r.serverId}`, dispatcher: r.dispatcher })),
      ...(this.envProxy ? [{ via: 'env', dispatcher: this.envProxy }] : []),
    ];
  }

  health(): TgHealthView {
    return { ...this.healthState, pending: this.pending().length };
  }

  private pending(): Pending[] {
    return getJsonSetting<Pending[]>(this.db, PENDING_KEY, []);
  }

  private setPending(list: Pending[]) {
    putSetting(this.db, PENDING_KEY, JSON.stringify(list.slice(-PENDING_MAX)));
  }

  /**
   * Итог отправки или проверки. Вернулась доставка после сбоя - true: пора отправить
   * накопленное (flush).
   */
  private record(ok: boolean, via: string | null, err: string | null): boolean {
    const now = new Date().toISOString();
    const h = this.healthState;
    const recovered = ok && h.ok === false;
    this.healthState = ok
      ? { ...h, ok: true, failingSince: null, lastOkAt: now, lastOkVia: via, checkedAt: now }
      : {
          ...h,
          ok: false,
          failingSince: h.ok === false && h.failingSince ? h.failingSince : now,
          lastError: err,
          checkedAt: now,
        };
    putSetting(this.db, HEALTH_KEY, JSON.stringify(this.healthState));
    return recovered;
  }

  async settings(): Promise<TgSettings> {
    const rows = await this.db.select().from(settings);
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    const out: TgSettings = structuredClone(defaultTg);
    out.token = this.box.open(get('tg_token') ?? '');
    out.chatId = get('tg_chat_id') ?? '';
    try {
      out.events = readNotifyEvents(
        JSON.parse(get('tg_events') ?? '{}') as Record<string, unknown>,
      );
    } catch {
      // оставляем по умолчанию
    }
    try {
      const m = JSON.parse(get('tg_muted_servers') ?? '[]') as unknown;
      if (Array.isArray(m)) out.mutedServers = m.filter((x): x is string => typeof x === 'string');
    } catch {}
    const num = (k: string, key: keyof NotifyParams) => {
      const [lo, hi] = NOTIFY_PARAM_LIMITS[key];
      const v = Number(get(k));
      return Number.isInteger(v) && v >= lo && v <= hi && get(k) !== undefined
        ? v
        : NOTIFY_PARAM_DEFAULTS[key];
    };
    out.banThreshold = num('tg_ban_threshold', 'banThreshold');
    out.paymentDays = num('tg_payment_days', 'paymentDays');
    out.offlineMinutes = num('tg_offline_minutes', 'offlineMinutes');
    return out;
  }

  /** Включено ли событие для сервера (сервер не отключён в уведомлениях). */
  async wants(event: NotifyEvent, serverId?: string): Promise<boolean> {
    const st = await this.settings();
    if (!st.token || !st.chatId || !st.events[event]) return false;
    return !serverId || !st.mutedServers.includes(serverId);
  }

  async save(patch: { [K in keyof TgSettings]?: TgSettings[K] | undefined }) {
    const put = async (key: string, value: string) => putSetting(this.db, key, value);
    if (patch.token !== undefined)
      await put('tg_token', patch.token ? this.box.seal(patch.token) : '');
    if (patch.chatId !== undefined) await put('tg_chat_id', patch.chatId);
    if (patch.events !== undefined) await put('tg_events', JSON.stringify(patch.events));
    if (patch.mutedServers !== undefined)
      await put('tg_muted_servers', JSON.stringify(patch.mutedServers));
    if (patch.banThreshold !== undefined) await put('tg_ban_threshold', String(patch.banThreshold));
    if (patch.paymentDays !== undefined) await put('tg_payment_days', String(patch.paymentDays));
    if (patch.offlineMinutes !== undefined)
      await put('tg_offline_minutes', String(patch.offlineMinutes));
  }

  /** Кто последний раз успешно доставил: 'direct' или id сервера-ретранслятора. */
  private route: { via: string; at: number } | null = null;

  /**
   * Отправка. Сначала напрямую; если api.telegram.org с хоста панели недоступен (в РФ его
   * блокируют), просим переслать агент на другом сервере (telegram.send). Рабочий путь
   * запоминаем на час. Возвращает ошибку текстом или null - каждому вызову свою: второй вызов
   * во время отправки не получает чужой "успех", а ошибка не выбрасывает всю очередь.
   */
  send(text: string, opts: { keep?: boolean } = {}): Promise<string | null> {
    const keep = opts.keep ?? true;
    const run = async () => {
      const st = await this.settings();
      if (!st.token || !st.chatId) return 'не заданы токен бота или chat id';
      const pending = this.pending();
      // пока не доходит - копим, не тратя время на заведомо мёртвые пути при каждом событии
      // (проверка раз в 5 минут и тестовое сообщение пробуют заново)
      if (keep && this.healthState.ok === false && pending.length > 0) {
        this.setPending([...pending, { at: new Date().toISOString(), text }]);
        return 'уведомления сейчас не доходят: сообщение отложено';
      }
      const r = await this.deliver(st, text);
      if (r.err) {
        this.log.warn({ err: r.err }, 'telegram: не отправлено');
        this.record(false, null, r.err);
        if (keep) this.setPending([...pending, { at: new Date().toISOString(), text }]);
      } else if (this.record(true, r.via, null) || pending.length > 0) {
        await this.flush(st);
      }
      // пауза между сообщениями: у Telegram лимит на частоту
      await new Promise((r) => setTimeout(r, 300));
      return r.err;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * Проверка доставки раз в 5 минут: getMe бота по обычному пути (агентам - getUpdates). Если
   * доставка вернулась - уходит накопленное со сводкой.
   */
  probe(): Promise<void> {
    const run = async () => {
      const st = await this.settings();
      if (!st.token || !st.chatId) return;
      const r = await this.call(st.token, 'getMe', {});
      if (r.err) {
        this.record(false, null, r.err);
        return;
      }
      if (this.record(true, r.via ?? null, null) || this.pending().length > 0) await this.flush(st);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Сводка о перерыве и накопленные сообщения по порядку; не ушло - остаётся на потом. */
  private async flush(st: TgSettings) {
    const list = this.pending();
    if (!list.length) return;
    const first = list[0]?.at ?? new Date().toISOString();
    const head = await this.deliver(
      st,
      `VPS Panel: уведомления не доходили с ${tgTime(first)} по ${tgTime(new Date().toISOString())} (МСК). Отложенных сообщений: ${list.length}, они ниже.`,
    );
    // getMe проходит и при неверном chat id: доставку решает сама отправка
    if (head.err) {
      this.record(false, null, head.err);
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const m = list[i] as Pending;
      await new Promise((r) => setTimeout(r, 300));
      const r = await this.deliver(st, `[${tgTime(m.at)}] ${m.text}`);
      if (r.err) {
        this.record(false, null, r.err);
        this.setPending(list.slice(i));
        return;
      }
    }
    this.setPending([]);
  }

  /** Ответ Telegram (HTTP не 200) человеческим языком. */
  private explain(status: number, body: string): string {
    let desc = '';
    try {
      desc = String((JSON.parse(body) as { description?: string }).description ?? '');
    } catch {
      desc = body.slice(0, 200);
    }
    const d = desc.toLowerCase();
    if (status === 401 || d.includes('unauthorized')) {
      return 'Telegram не принял токен бота (401)';
    }
    if (d.includes('chat not found')) {
      return 'Telegram не нашёл чат (400): отправьте боту любое сообщение и нажмите \u00abНайти chat id\u00bb';
    }
    if (d.includes('blocked by the user')) return 'Telegram: бот заблокирован в чате (403)';
    if (d.includes("can't initiate") || (status === 403 && d.includes('forbidden'))) {
      return 'Telegram: бот не может писать первым (403), отправьте боту любое сообщение';
    }
    return `Telegram ответил ${status}: ${desc || body.slice(0, 200)}`;
  }

  /**
   * Вызов Bot API с хоста панели: напрямую или через HTTP-прокси (xray рядом с панелью).
   * Возвращает тело ответа; ошибка Telegram - строкой с префиксом "Telegram", сетевая - без него
   * (тогда имеет смысл другой путь).
   */
  private async direct(
    token: string,
    method: TgMethod,
    params: Record<string, unknown>,
    proxy: ProxyAgent | null,
  ): Promise<{ raw?: string; err?: string }> {
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(proxy ? 15_000 : 8_000),
      };
      const url = `https://api.telegram.org/bot${token}/${method}`;
      const res = proxy
        ? await ufetch(url, { ...init, dispatcher: proxy })
        : await fetch(url, init);
      const raw = await res.text();
      if (res.ok) return { raw };
      return { err: this.explain(res.status, raw) };
    } catch (e) {
      const err = e as Error & { cause?: Error };
      return {
        err: `${proxy ? 'через прокси' : 'с сервера панели'}: ${err.cause?.message ?? err.message}`,
      };
    }
  }

  private async viaAgent(
    serverId: string,
    token: string,
    method: TgMethod,
    params: Record<string, unknown>,
  ): Promise<{ raw?: string; err?: string }> {
    try {
      if (method === 'sendMessage') {
        await this.registry.request(
          serverId,
          'telegram.send',
          { token, chatId: params.chat_id, text: params.text },
          { timeoutMs: 30_000 },
        );
        return { raw: '{"ok":true}' };
      }
      const r = (await this.registry.request(
        serverId,
        'telegram.updates',
        { token },
        { timeoutMs: 30_000 },
      )) as { raw?: string };
      return { raw: r?.raw ?? '' };
    } catch (e) {
      const m = (e as Error).message;
      // агент дошёл до Telegram, но тот отказал: "telegram ответил 403: {...}"
      const hit = /telegram ответил (\d{3}): (.*)$/s.exec(m);
      if (hit) return { err: this.explain(Number(hit[1]), hit[2] ?? '') };
      return { err: m };
    }
  }

  private isTelegramAnswer(err: string): boolean {
    return err.startsWith('Telegram');
  }

  /**
   * Вызов Bot API. Пути по порядку: выходы xray (последний рабочий первым) и прокси из
   * окружения - напрямую - через агентов на серверах (api.telegram.org с хоста панели в РФ
   * недоступен). Рабочий путь запоминаем на час; ответ самого Telegram (401/403/400) -
   * окончательный, другие пути не пробуем. via в ответе - каким путём дошло.
   */
  async call(
    token: string,
    method: TgMethod,
    params: Record<string, unknown>,
  ): Promise<{ raw?: string; err?: string; via?: string }> {
    const proxies = this.proxies();
    const attempt = (via: string) => {
      if (via === 'direct') return this.direct(token, method, params, null);
      if (via.startsWith('agent:')) return this.viaAgent(via.slice(6), token, method, params);
      const p = proxies.find((x) => x.via === via);
      return p
        ? this.direct(token, method, params, p.dispatcher)
        : Promise.resolve({ err: 'выход больше не настроен' });
    };
    const done = (via: string) => {
      this.lastRoute = { via, at: new Date().toISOString() };
      if (via.startsWith('proxy:')) this.xray.worked(via.slice(6));
    };
    // Агент - запасной путь: при настроенных выходах xray (или прокси) он запоминается на 10
    // минут, потом снова пробуем основной - иначе после настройки маршрута до Telegram сообщения
    // ещё час шли бы через агента.
    const ttl =
      this.route?.via.startsWith('agent:') && proxies.length > 0 ? 10 * 60_000 : 60 * 60_000;
    const fresh = this.route && Date.now() - this.route.at < ttl;
    if (fresh && this.route) {
      const via = this.route.via;
      const r = await attempt(via);
      if (!r.err) done(via);
      if (!r.err || this.isTelegramAnswer(r.err)) return { ...r, via };
      this.route = null;
    }
    const errors: string[] = [];
    const paths = [
      ...proxies.map((p) => p.via),
      'direct',
      ...this.registry.onlineIds().map((id) => `agent:${id}`),
    ];
    for (const via of paths) {
      const r = await attempt(via);
      if (!r.err) {
        this.route = { via, at: Date.now() };
        done(via);
        this.log.info({ via }, 'telegram: путь доставки');
        return { ...r, via };
      }
      // ответ Telegram (не сетевая ошибка) означает, что дошли: другой путь не поможет
      if (this.isTelegramAnswer(r.err)) return { ...r, via };
      errors.push(`${via}: ${r.err}`);
    }
    const agentErrors = errors.filter((e) => !e.startsWith('proxy:') && !e.startsWith('direct:'));
    if (agentErrors.length > 0 && agentErrors.every((e) => e.includes(AGENT_OUTDATED))) {
      return {
        err: 'Telegram недоступен с сервера панели, а агенты на серверах устарели: нужно обновить агенты',
      };
    }
    return {
      err: `Telegram недоступен ни с сервера панели, ни через агенты: ${errors.slice(0, 3).join('; ')}`,
    };
  }

  /**
   * Файл в чат (бэкап панели): через прокси xray, затем напрямую. Через агентов файлы не
   * пересылаются (они умеют только текст). caption - HTML (команды - в <pre>, текст через esc).
   * Возвращает ошибку текстом или null.
   */
  async sendDocument(name: string, data: Buffer, caption: string): Promise<string | null> {
    const st = await this.settings();
    if (!st.token || !st.chatId) return 'не заданы токен бота или chat id';
    // multipart собираем сами: одинаково для undici с прокси и встроенного fetch
    const boundary = `----vps${randomBytes(12).toString('hex')}`;
    const field = (k: string, v: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const body = Buffer.concat([
      Buffer.from(
        `${field('chat_id', st.chatId)}${field('caption', caption)}${field('parse_mode', 'HTML')}--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const errors: string[] = [];
    for (const p of [...this.proxies(), null]) {
      try {
        const init = {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(120_000),
        };
        const url = `https://api.telegram.org/bot${st.token}/sendDocument`;
        const res = p
          ? await ufetch(url, { ...init, dispatcher: p.dispatcher })
          : await fetch(url, init);
        const raw = await res.text();
        // ответ самого Telegram окончательный: другой путь не поможет
        return res.ok ? null : this.explain(res.status, raw);
      } catch (e) {
        errors.push(`${p ? 'через прокси' : 'с сервера панели'}: ${(e as Error).message}`);
      }
    }
    return `Telegram недоступен: ${errors.join('; ')} (через агенты файлы не передаются)`;
  }

  private async deliver(
    st: TgSettings,
    msg: string,
  ): Promise<{ err: string | null; via: string | null }> {
    const r = await this.call(st.token, 'sendMessage', {
      chat_id: st.chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { err: r.err ?? null, via: r.via ?? null };
  }

  /** Кто писал боту: подбор chat id для настроек. Токен - из формы или сохранённый. */
  async detectChats(
    tokenFromForm?: string,
  ): Promise<{ chats?: { id: string; title: string; when: string }[]; err?: string }> {
    const token = tokenFromForm || (await this.settings()).token;
    if (!token) return { err: 'не задан токен бота' };
    const r = await this.call(token, 'getUpdates', {
      limit: 100,
      allowed_updates: ['message', 'my_chat_member', 'channel_post'],
    });
    if (r.err) return { err: r.err };
    let parsed: {
      result?: {
        message?: TgMsg;
        channel_post?: TgMsg;
        my_chat_member?: { chat: TgChat; date: number };
      }[];
    };
    try {
      parsed = JSON.parse(r.raw ?? '{}');
    } catch {
      return { err: 'Telegram вернул нечитаемый ответ' };
    }
    const seen = new Map<string, { id: string; title: string; when: string }>();
    for (const u of parsed.result ?? []) {
      const m = u.message ?? u.channel_post ?? u.my_chat_member;
      if (!m?.chat) continue;
      const c = m.chat;
      const title =
        c.title ||
        [c.first_name, c.last_name].filter(Boolean).join(' ') ||
        (c.username ? `@${c.username}` : String(c.id));
      const kind = c.type === 'private' ? 'личный чат' : c.type === 'channel' ? 'канал' : 'группа';
      seen.set(String(c.id), {
        id: String(c.id),
        title: `${title} (${kind})`,
        when: new Date(m.date * 1000).toISOString(),
      });
    }
    return { chats: [...seen.values()].reverse() };
  }
}

/** Экранирование для сообщений с parse_mode HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
