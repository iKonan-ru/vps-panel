import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Agent as HttpAgent,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
  request as httpRequest,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Service } from '@vps/protocol';
import { and, eq, gt } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers, sessions } from '../db/schema.js';
import { TunnelSocket, tunnelConnection } from './agent-tunnel.js';

/**
 * Панели сервисов через поддомены панели: `<слаг сервера>-xui.<домен>` и
 * `-mtproxyl`. Запрос идёт туннелем через агента к 127.0.0.1:<порт панели> на сервере
 * (lib/agent-tunnel.ts) - панели сервисов могут слушать только loopback. Вход - только через
 * панель: ссылка "Открыть" выдаёт одноразовый тикет, по нему на поддомен ставится своя cookie
 * (HMAC секрета панели, привязана к живой сессии панели). Сертификат поддомена Caddy выпускает
 * по требованию, спросив /api/proxy/ask.
 *
 * Свой прокси на node:http, а не http-proxy: тот ронял процесс ошибкой внутри
 * обработчика. Здесь любая ошибка - 502 (или обрыв, если ответ уже начат), не throw.
 */
export const PROXIED_KINDS = ['xui', 'mtproxyl'] as const;
type Kind = (typeof PROXIED_KINDS)[number];

const COOKIE = '__Host-vps_proxy';
const TICKET_TTL_MS = 60_000;
const COOKIE_TTL_S = 12 * 3600;
/** Заголовки hop-by-hop: не пересылаются (RFC 9110, 7.6.1). */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
]);

const translit: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Слаг поддомена из имени сервера: латиница, кириллица транслитом, остальное - дефис. */
export function slugify(name: string): string {
  const s = [...name.toLowerCase()]
    .map((ch) => translit[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'srv';
}

export interface ProxyTarget {
  serverId: string;
  kind: Kind;
  port: number;
  tls: boolean;
  basePath: string;
}

/** Порт, схема и путь панели сервиса из снимка агента. */
export function panelTarget(services: Service[], kind: Kind) {
  const url = services.find((s) => s.kind === kind)?.panelUrl;
  if (!url) return null;
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!port) return null;
    return { port, tls: u.protocol === 'https:', basePath: u.pathname || '/' };
  } catch {
    return null;
  }
}

function page(title: string, text: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
div{max-width:420px;padding:24px;border:1px solid #2a2f3a;border-radius:12px}h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b2;margin:0}</style></head>
<body><div><h1>${title}</h1><p>${text}</p></div></body></html>`;
}

type Log = { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };

/** Итог проверки панели сервиса перед входом; stage - на каком шаге не вышло. */
export interface ProxyProbe {
  ok: boolean;
  stage?: 'target' | 'agent' | 'tunnel' | 'panel';
  error?: string;
  serverId?: string;
  server?: string;
  kind?: Kind;
  /** Сколько агент открывал соединение с портом панели. */
  tunnelMs?: number;
  /** Сколько панель отвечала на первый запрос. */
  panelMs?: number;
}

/**
 * Запрос браузера к панели сервиса через пул туннелей. GET и HEAD без тела на соединении из пула
 * повторяются один раз новым соединением, если оно оборвалось до ответа: панель сервиса закрывает
 * простаивающее соединение, а весть об этом идёт через агента с задержкой, и запрос успевает уйти
 * в уже закрытое (ответ "socket hang up", страница не открывалась до перезагрузки). Ошибка - 502
 * или обрыв, если ответ уже начат; onError - для журнала. Никогда не бросает.
 */
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  up: { headers: OutgoingHttpHeaders; port: number; tls: boolean; agent: HttpAgent },
  onError: (e: Error, retried: boolean) => void,
) {
  const { headers, port, tls, agent } = up;
  const request = tls ? httpsRequest : httpRequest;
  const bodyless =
    (req.method === 'GET' || req.method === 'HEAD') &&
    !req.headers['content-length'] &&
    !req.headers['transfer-encoding'];
  const send = (retry: boolean) => {
    const up = request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
      agent,
      rejectUnauthorized: false,
      timeout: 120_000,
    });
    up.on('response', (r) => {
      try {
        const out: OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(r.headers))
          if (v !== undefined && !HOP.has(k)) out[k] = v;
        res.writeHead(r.statusCode ?? 502, out);
        r.pipe(res);
        r.on('error', () => res.destroy());
      } catch {
        res.destroy();
      }
    });
    up.on('timeout', () => up.destroy(new Error('таймаут')));
    up.on('error', (e) => {
      if (retry && up.reusedSocket && !res.headersSent && !res.destroyed) return send(false);
      onError(e, !retry && bodyless);
      failPage(res, 502, 'Панель сервиса не отвечает', e.message);
    });
    const abort = () => {
      if (!res.writableFinished) up.destroy();
    };
    res.once('close', abort);
    up.once('close', () => res.removeListener('close', abort));
    if (bodyless) up.end();
    else {
      req.pipe(up);
      req.on('error', () => up.destroy());
    }
  };
  res.on('error', () => undefined);
  send(bodyless);
}

/** Страница ошибки прокси (или обрыв, если ответ уже начат). Никогда не бросает. */
function failPage(res: ServerResponse, status: number, title: string, text: string) {
  try {
    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(page(title, text));
    } else res.destroy();
  } catch {
    res.destroy();
  }
}

export class PanelProxy {
  private tickets = new Map<string, { label: string; sid: string; exp: number }>();
  private sessionOk = new Map<string, { ok: boolean; at: number }>();
  private targets = new Map<string, { t: ProxyTarget | null; at: number }>();
  private agents = new Map<string, HttpAgent>();

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    /** Домен панели (panel.example.com); пусто - поддомены выключены (стенд, тесты). */
    readonly domain: string,
    private secret: string,
    private log: Log,
  ) {}

  /**
   * Метка поддомена панели сервиса из Host (<слаг>-xui, <слаг>-mtproxyl), иначе null - запрос
   * идёт в саму панель. Только эти окончания: sub.<домен> (подписки и личные страницы) и любые
   * другие имена домена прокси не трогает (иначе sub.<домен> отвечал бы 404).
   */
  labelOf(host: string | undefined): string | null {
    if (!host || !this.domain) return null;
    const h = host.split(':')[0]?.toLowerCase() ?? '';
    if (!h.endsWith(`.${this.domain}`)) return null;
    const label = h.slice(0, -(this.domain.length + 1));
    if (!/^[a-z0-9-]{1,63}$/.test(label)) return null;
    return PROXIED_KINDS.some((k) => label.endsWith(`-${k}`) && label.length > k.length + 1)
      ? label
      : null;
  }

  /** Ссылки "Открыть панель" сервера: вид сервиса -> адрес входа через панель. */
  links(serverId: string, name: string, services: Service[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (!this.domain || !this.registry.supports(serverId, 'tunnel.open')) return out;
    for (const kind of PROXIED_KINDS) {
      if (panelTarget(services, kind)) out[kind] = this.openUrl(`${slugify(name)}-${kind}`, '');
    }
    return out;
  }

  /** Сервер и панель по метке; null - нет такой (или два сервера с одним слагом). */
  async target(label: string): Promise<ProxyTarget | null> {
    const c = this.targets.get(label);
    if (c && Date.now() - c.at < 10_000) return c.t;
    let t: ProxyTarget | null = null;
    const kind = PROXIED_KINDS.find((k) => label.endsWith(`-${k}`));
    if (kind) {
      const slug = label.slice(0, -(kind.length + 1));
      const rows = (
        await this.db
          .select({ id: servers.id, name: servers.name, cache: servers.statusCache })
          .from(servers)
      ).filter((r) => slugify(r.name) === slug);
      const row = rows.length === 1 ? rows[0] : undefined;
      const services = (row?.cache as StatusCache | null)?.inventory?.services ?? [];
      const p = row ? panelTarget(services, kind) : null;
      if (row && p) t = { serverId: row.id, kind, ...p };
    }
    this.targets.set(label, { t, at: Date.now() });
    return t;
  }

  openUrl(label: string, back: string): string {
    const q = back ? `?back=${encodeURIComponent(back)}` : '';
    return `https://${this.domain}/api/proxy/open/${encodeURIComponent(label)}${q}`;
  }

  // ---- вход на поддомен

  /** Одноразовый тикет для перехода с панели на поддомен (sid - id сессии панели). */
  issueTicket(label: string, sid: string): string {
    for (const [k, v] of this.tickets) if (v.exp < Date.now()) this.tickets.delete(k);
    const t = randomBytes(24).toString('base64url');
    this.tickets.set(t, { label, sid, exp: Date.now() + TICKET_TTL_MS });
    return t;
  }

  private sign(label: string, sid: string, exp: number): string {
    return createHmac('sha256', this.secret)
      .update(`proxy|${label}|${sid}|${exp}`)
      .digest('base64url');
  }

  private makeCookie(label: string, sid: string): string {
    const exp = Date.now() + COOKIE_TTL_S * 1000;
    return `${label}.${sid}.${exp}.${this.sign(label, sid, exp)}`;
  }

  /** Сессия панели жива (кэш 30 с: панель сервиса шлёт много запросов). */
  private async alive(sid: string): Promise<boolean> {
    const c = this.sessionOk.get(sid);
    if (c && Date.now() - c.at < 30_000) return c.ok;
    const row = (
      await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date().toISOString())))
        .limit(1)
    )[0];
    const ok = Boolean(row);
    this.sessionOk.set(sid, { ok, at: Date.now() });
    return ok;
  }

  private async verifyCookie(value: string | undefined, label: string): Promise<boolean> {
    if (!value) return false;
    const [l, sid, expS, sig] = value.split('.');
    if (!l || !sid || !expS || !sig || l !== label) return false;
    const exp = Number(expS);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const want = this.sign(l, sid, exp);
    if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig)))
      return false;
    return this.alive(sid);
  }

  private cookieOf(req: IncomingMessage): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return undefined;
  }

  // ---- проксирование

  private agentFor(t: ProxyTarget): HttpAgent {
    const key = `${t.serverId}:${t.port}:${t.tls}`;
    let a = this.agents.get(key);
    if (!a) {
      const opts = { keepAlive: true, maxSockets: 8, timeout: 60_000 };
      a = t.tls ? new HttpsAgent(opts) : new HttpAgent(opts);
      const conn = () => tunnelConnection(this.registry, t.serverId, t.port, t.tls);
      (a as unknown as { createConnection: typeof conn }).createConnection = conn;
      this.agents.set(key, a);
    }
    return a;
  }

  /** Заголовки к панели сервиса: без hop-by-hop и без нашей cookie. */
  private upstreamHeaders(req: IncomingMessage, keepUpgrade = false): OutgoingHttpHeaders {
    const h: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (
        v === undefined ||
        (HOP.has(k) && !(keepUpgrade && (k === 'upgrade' || k === 'connection')))
      )
        continue;
      if (k === 'cookie') {
        const kept = String(v)
          .split(';')
          .map((c) => c.trim())
          .filter((c) => c && !c.startsWith(`${COOKIE}=`));
        if (kept.length) h.cookie = kept.join('; ');
        continue;
      }
      h[k] = v;
    }
    const ip = req.socket.remoteAddress ?? '';
    const xff = req.headers['x-forwarded-for'];
    h['x-forwarded-for'] = xff ? `${xff}, ${ip}` : ip;
    h['x-forwarded-proto'] = 'https';
    return h;
  }

  private fail(res: ServerResponse, status: number, title: string, text: string) {
    failPage(res, status, title, text);
  }

  /**
   * HTTP-запрос к поддомену (до Fastify, см. app.ts). false - хост не наш, запрос идёт дальше
   * в Fastify. Никогда не бросает.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const label = this.labelOf(req.headers.host);
    if (!label) return false;
    try {
      await this.serve(label, req, res);
    } catch (e) {
      this.log.warn({ err: (e as Error).message, label }, 'proxy: ошибка');
      this.fail(res, 502, 'Ошибка прокси', 'Попробуйте ещё раз.');
    }
    return true;
  }

  private async serve(label: string, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const t = await this.target(label);
    if (!t)
      return this.fail(res, 404, 'Панель не найдена', `Поддомен ${label} не знает VPS Panel.`);
    if (url.pathname === '/__vps/auth') {
      const ticket = this.tickets.get(url.searchParams.get('t') ?? '');
      this.tickets.delete(url.searchParams.get('t') ?? '');
      const back = url.searchParams.get('back') ?? '';
      if (!ticket || ticket.label !== label || ticket.exp < Date.now()) {
        res.writeHead(302, { location: this.openUrl(label, back), 'cache-control': 'no-store' });
        return res.end();
      }
      const to = back.startsWith('/') && !back.startsWith('//') ? back : t.basePath;
      res.writeHead(302, {
        location: to,
        'cache-control': 'no-store',
        'set-cookie': `${COOKIE}=${this.makeCookie(label, ticket.sid)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_S}`,
      });
      return res.end();
    }
    // манифест PWA и favicon браузер просит без cookie; секретов там нет
    const publicFile = /(^|\/)(manifest\.(webmanifest|json)|favicon\.ico)$/.test(url.pathname);
    if (!publicFile && !(await this.verifyCookie(this.cookieOf(req), label))) {
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        res.writeHead(302, {
          location: this.openUrl(label, url.pathname + url.search),
          'cache-control': 'no-store',
        });
        return res.end();
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"Войдите в VPS Panel"}');
    }
    if (!this.registry.isOnline(t.serverId))
      return this.fail(res, 502, 'Сервер не на связи', 'Агент сервера не подключён к VPS Panel.');

    const upstream = {
      headers: this.upstreamHeaders(req),
      port: t.port,
      tls: t.tls,
      agent: this.agentFor(t),
    };
    forwardHttp(req, res, upstream, (e, retried) =>
      this.log.warn({ err: e.message, label, retried }, 'proxy: панель сервиса не ответила'),
    );
  }

  /**
   * Проверка перед входом на поддомен (страница "Открываю панель"): агент на связи, туннель до
   * порта панели открывается, панель отвечает на HTTP. Заодно прогревает пул соединений:
   * первые запросы браузера идут по уже открытому каналу. Никогда не бросает.
   */
  async probe(label: string): Promise<ProxyProbe> {
    const t = await this.target(label);
    if (!t) return { ok: false, stage: 'target', error: 'Такой панели сервиса нет' };
    const row = this.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, t.serverId))
      .get();
    const base = { serverId: t.serverId, server: row?.name ?? '', kind: t.kind };
    if (!this.registry.isOnline(t.serverId))
      return { ...base, ok: false, stage: 'agent', error: 'Агент сервера не на связи с VPS Panel' };
    if (!this.registry.supports(t.serverId, 'tunnel.open'))
      return { ...base, ok: false, stage: 'agent', error: 'Агент устарел: обновите агента' };
    const t0 = Date.now();
    const opened = await new Promise<string | null>((resolve) => {
      const sock = new TunnelSocket(this.registry, t.serverId, t.port);
      sock.on('error', () => undefined);
      const done = (err: string | null) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(err);
      };
      const timer = setTimeout(() => done('агент не открыл соединение за 10 с'), 10_000);
      sock.once('tunnel-open', () => done(null));
      sock.once('tunnel-fail', (m: string) => done(m));
      sock.once('close', () => done('соединение закрыто'));
    });
    const tunnelMs = Date.now() - t0;
    if (opened)
      return {
        ...base,
        ok: false,
        stage: 'tunnel',
        tunnelMs,
        error: `Панель не слушает порт ${t.port} на сервере: ${opened}`,
      };
    const t1 = Date.now();
    const status = await new Promise<number | string>((resolve) => {
      const request = t.tls ? httpsRequest : httpRequest;
      const send = (retry: boolean) => {
        const up = request({
          host: '127.0.0.1',
          port: t.port,
          method: 'GET',
          path: t.basePath,
          headers: { 'user-agent': 'vps-panel-probe' },
          agent: this.agentFor(t),
          rejectUnauthorized: false,
          timeout: 20_000,
        });
        up.on('response', (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        up.on('timeout', () => up.destroy(new Error('нет ответа за 20 с')));
        up.on('error', (e) => (retry && up.reusedSocket ? send(false) : resolve(e.message)));
        up.end();
      };
      send(true);
    });
    const panelMs = Date.now() - t1;
    if (typeof status === 'string')
      return { ...base, ok: false, stage: 'panel', tunnelMs, panelMs, error: status };
    if (status >= 500)
      return {
        ...base,
        ok: false,
        stage: 'panel',
        tunnelMs,
        panelMs,
        error: `Панель ответила ошибкой ${status}`,
      };
    return { ...base, ok: true, tunnelMs, panelMs };
  }

  /** WebSocket к поддомену. false - хост не наш. Никогда не бросает. */
  async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> {
    const label = this.labelOf(req.headers.host);
    if (!label) return false;
    socket.on('error', () => socket.destroy());
    try {
      const t = await this.target(label);
      if (
        !t ||
        !(await this.verifyCookie(this.cookieOf(req), label)) ||
        !this.registry.isOnline(t.serverId)
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return true;
      }
      const request = t.tls ? httpsRequest : httpRequest;
      const up = request({
        host: '127.0.0.1',
        port: t.port,
        method: req.method,
        path: req.url,
        headers: this.upstreamHeaders(req, true),
        // свой поток на соединение: websocket не возвращается в пул keep-alive
        createConnection: () => tunnelConnection(this.registry, t.serverId, t.port, t.tls),
        rejectUnauthorized: false,
      } as RequestOptions);
      up.on('upgrade', (r, upSocket, upHead) => {
        const lines = [`HTTP/1.1 101 ${r.statusMessage ?? 'Switching Protocols'}`];
        for (let i = 0; i < r.rawHeaders.length; i += 2)
          lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSocket.write(head);
        upSocket.on('error', () => socket.destroy());
        socket.on('close', () => upSocket.destroy());
        upSocket.on('close', () => socket.destroy());
        upSocket.pipe(socket);
        socket.pipe(upSocket);
      });
      up.on('response', (r) => {
        socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\n\r\n`);
        r.resume();
      });
      up.on('error', () => socket.destroy());
      up.end();
    } catch (e) {
      this.log.warn({ err: (e as Error).message, label }, 'proxy: ошибка websocket');
      socket.destroy();
    }
    return true;
  }

  /** Подмена слушателей upgrade: наши хосты - в прокси, остальное - как было (@fastify/websocket). */
  attachUpgrade(server: Server) {
    const orig = server.listeners('upgrade') as ((
      req: IncomingMessage,
      socket: Socket,
      head: Buffer,
    ) => void)[];
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!this.labelOf(req.headers.host)) {
        for (const l of orig) l(req, socket, head);
        return;
      }
      void this.handleUpgrade(req, socket, head);
    });
  }
}
