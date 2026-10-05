import { randomBytes } from 'node:crypto';
import { ProxyAgent, fetch as ufetch } from 'undici';
import { AGENT_OUTDATED, type AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import type { SecretBox } from './secret-box.js';
import { putSetting } from './settings.js';

/** Настройки Telegram в таблице setting (ключ tg_*). */
export interface TgSettings {
  token: string;
  chatId: string;
  events: {
    offline: boolean;
    audit: boolean;
    bans: boolean;
    updates: boolean;
  };
  banThreshold: number; // банов в час, после которых шлём
  paymentDays: number; // за сколько дней предупреждать о платеже
}

export const defaultTg: TgSettings = {
  token: '',
  chatId: '',
  events: { offline: true, audit: true, bans: true, updates: true },
  banThreshold: 10,
  paymentDays: 3,
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

/**
 * Telegram Bot API: настройки бота (token, chat id, события) и доставка - прокси xray, напрямую,
 * через агента на другом сервере. Правила событий - lib/notify.ts.
 */
export class Telegram {
  /** Сообщения уходят по одному, в порядке вызова: цепочка отправок. */
  private chain: Promise<unknown> = Promise.resolve();

  private envProxy: ProxyAgent | null;
  /** Последняя успешная доставка: каким путём и когда (для настроек). */
  lastRoute: { via: string; at: string } | null = null;

  constructor(
    private db: Db,
    /** Токен бота хранится зашифрованным, как пароли в "Доступах". */
    private box: SecretBox,
    private registry: AgentRegistry,
    private log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
    /** Прокси xray, которым управляет панель (null, если не запущен). */
    private xrayProxy: () => ProxyAgent | null = () => null,
    envProxyUrl = '',
  ) {
    this.envProxy = envProxyUrl ? new ProxyAgent(envProxyUrl) : null;
  }

  private get proxy(): ProxyAgent | null {
    return this.xrayProxy() ?? this.envProxy;
  }

  async settings(): Promise<TgSettings> {
    const rows = await this.db.select().from(settings);
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    const out: TgSettings = structuredClone(defaultTg);
    out.token = this.box.open(get('tg_token') ?? '');
    out.chatId = get('tg_chat_id') ?? '';
    try {
      const ev = get('tg_events');
      if (ev) out.events = { ...out.events, ...(JSON.parse(ev) as Partial<TgSettings['events']>) };
    } catch {
      // оставляем по умолчанию
    }
    out.banThreshold =
      Number(get('tg_ban_threshold') ?? defaultTg.banThreshold) || defaultTg.banThreshold;
    out.paymentDays =
      Number(get('tg_payment_days') ?? defaultTg.paymentDays) || defaultTg.paymentDays;
    return out;
  }

  async save(patch: { [K in keyof TgSettings]?: TgSettings[K] | undefined }) {
    const put = async (key: string, value: string) => putSetting(this.db, key, value);
    if (patch.token !== undefined)
      await put('tg_token', patch.token ? this.box.seal(patch.token) : '');
    if (patch.chatId !== undefined) await put('tg_chat_id', patch.chatId);
    if (patch.events !== undefined) await put('tg_events', JSON.stringify(patch.events));
    if (patch.banThreshold !== undefined) await put('tg_ban_threshold', String(patch.banThreshold));
    if (patch.paymentDays !== undefined) await put('tg_payment_days', String(patch.paymentDays));
  }

  /** Кто последний раз успешно доставил: 'direct' или id сервера-ретранслятора. */
  private route: { via: string; at: number } | null = null;

  /**
   * Отправка. Сначала напрямую; если api.telegram.org с хоста панели недоступен (в РФ его
   * блокируют), просим переслать агент на другом сервере (telegram.send). Рабочий путь
   * запоминаем на час. Возвращает ошибку текстом или null - каждому вызову свою: второй вызов
   * во время отправки не получает чужой "успех", а ошибка не выбрасывает всю очередь.
   */
  send(text: string): Promise<string | null> {
    const run = async () => {
      const st = await this.settings();
      if (!st.token || !st.chatId) return 'не заданы токен бота или chat id';
      const err = await this.deliver(st, text);
      if (err) this.log.warn({ err }, 'telegram: не отправлено');
      // пауза между сообщениями: у Telegram лимит на частоту
      await new Promise((r) => setTimeout(r, 300));
      return err;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
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
      return 'Telegram не принял токен бота (401): проверь токен из @BotFather';
    }
    if (d.includes('chat not found')) {
      return 'Telegram: чат не найден (400). Напиши боту любое сообщение и нажми "Найти chat id"';
    }
    if (d.includes('blocked by the user')) return 'Telegram: ты заблокировал этого бота (403)';
    if (d.includes("can't initiate") || (status === 403 && d.includes('forbidden'))) {
      return 'Telegram: бот не может писать первым (403). Открой чат с ботом, нажми Start и повтори';
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
    method: 'sendMessage' | 'getUpdates',
    params: Record<string, unknown>,
    viaProxy: boolean,
  ): Promise<{ raw?: string; err?: string }> {
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(viaProxy ? 15_000 : 8_000),
      };
      const url = `https://api.telegram.org/bot${token}/${method}`;
      const res =
        viaProxy && this.proxy
          ? await ufetch(url, { ...init, dispatcher: this.proxy })
          : await fetch(url, init);
      const raw = await res.text();
      if (res.ok) return { raw };
      return { err: this.explain(res.status, raw) };
    } catch (e) {
      return { err: `${viaProxy ? 'через прокси' : 'с хоста панели'}: ${(e as Error).message}` };
    }
  }

  private async viaAgent(
    serverId: string,
    token: string,
    method: 'sendMessage' | 'getUpdates',
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
   * Вызов Bot API. Пути по порядку: HTTP-прокси xray (если настроен) - напрямую - через агент
   * на другом сервере (api.telegram.org с хоста панели в РФ недоступен). Рабочий путь
   * запоминаем на час; ответ самого Telegram (401/403/400) - окончательный, другие пути не пробуем.
   */
  async call(
    token: string,
    method: 'sendMessage' | 'getUpdates',
    params: Record<string, unknown>,
  ): Promise<{ raw?: string; err?: string }> {
    const attempt = (via: string) =>
      via === 'proxy'
        ? this.direct(token, method, params, true)
        : via === 'direct'
          ? this.direct(token, method, params, false)
          : this.viaAgent(via, token, method, params);
    const fresh = this.route && Date.now() - this.route.at < 60 * 60_000;
    if (fresh && this.route) {
      const r = await attempt(this.route.via);
      if (!r.err) this.lastRoute = { via: this.route.via, at: new Date().toISOString() };
      if (!r.err || this.isTelegramAnswer(r.err)) return r;
      this.route = null;
    }
    const errors: string[] = [];
    const paths = [...(this.proxy ? ['proxy'] : []), 'direct', ...this.registry.onlineIds()];
    for (const via of paths) {
      const r = await attempt(via);
      if (!r.err) {
        this.route = { via, at: Date.now() };
        this.lastRoute = { via, at: new Date().toISOString() };
        this.log.info({ via }, 'telegram: путь доставки');
        return r;
      }
      // ответ Telegram (не сетевая ошибка) означает, что дошли: другой путь не поможет
      if (this.isTelegramAnswer(r.err)) return r;
      errors.push(`${via}: ${r.err}`);
    }
    const agentErrors = errors.filter((e) => !e.startsWith('proxy:') && !e.startsWith('direct:'));
    if (agentErrors.length > 0 && agentErrors.every((e) => e.includes(AGENT_OUTDATED))) {
      return {
        err: 'Telegram недоступен с хоста панели, а агенты на серверах старые: обнови агентов и повтори',
      };
    }
    return {
      err: `Telegram недоступен ни с панели, ни через агенты: ${errors.slice(0, 3).join('; ')}`,
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
    for (const viaProxy of [...(this.proxy ? [true] : []), false]) {
      try {
        const init = {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(120_000),
        };
        const url = `https://api.telegram.org/bot${st.token}/sendDocument`;
        const res =
          viaProxy && this.proxy
            ? await ufetch(url, { ...init, dispatcher: this.proxy })
            : await fetch(url, init);
        const raw = await res.text();
        // ответ самого Telegram окончательный: другой путь не поможет
        return res.ok ? null : this.explain(res.status, raw);
      } catch (e) {
        errors.push(`${viaProxy ? 'через прокси' : 'с хоста панели'}: ${(e as Error).message}`);
      }
    }
    return `Telegram недоступен: ${errors.join('; ')} (через агентов файлы не пересылаются)`;
  }

  private async deliver(st: TgSettings, msg: string): Promise<string | null> {
    const r = await this.call(st.token, 'sendMessage', {
      chat_id: st.chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return r.err ?? null;
  }

  /** Кто писал боту: подбор chat id для настроек. Токен - из формы или сохранённый. */
  async detectChats(
    tokenFromForm?: string,
  ): Promise<{ chats?: { id: string; title: string; when: string }[]; err?: string }> {
    const token = tokenFromForm || (await this.settings()).token;
    if (!token) return { err: 'сначала вставь токен бота' };
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
