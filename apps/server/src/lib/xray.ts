import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as ufetch } from 'undici';
import type { Db } from '../db/index.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';

/**
 * Выход панели в заблокированные сети (сейчас - Telegram): xray-клиент к VLESS-Reality
 * инбаундам 3x-ui на заграничных серверах. Бинарник xray лежит в образе панели, панель
 * запускает его как дочерний процесс, пишет конфиг в /data/xray и перезапускает при смене.
 *
 * Выходов несколько: основной выбирает владелец в настройках, запасные панель готовит сама
 * (routes/xray.ts, клиент vps-panel на каждом сервере с 3X-UI). У каждого выхода свой
 * HTTP-вход 127.0.0.1:3128+N с маршрутом в свой outbound: выходы проверяются по отдельности,
 * и переключение на запасной не требует перезапуска. Порядок для запросов - последний
 * рабочий первым, затем остальные по порядку (основной, запасные).
 */
export interface XrayOutbound {
  serverId: string;
  serverName: string;
  inboundId: number;
  inboundRemark: string;
  address: string;
  port: number;
  uuid: string;
  publicKey: string;
  shortId: string;
  sni: string;
  fingerprint: string;
  flow: string;
  updatedAt: string;
}

export type XrayCheck = { at: string; ok: boolean; ms: number; err: string | null };

/** Выход для интерфейса: без uuid целиком, с итогом последней проверки. */
export type XrayExitView = Omit<XrayOutbound, 'uuid' | 'publicKey' | 'shortId'> & {
  uuid: string;
  primary: boolean;
  lastCheck: XrayCheck | null;
};

export interface XrayStatus {
  configured: boolean;
  binary: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  /** Проверка основного выхода (как раньше). */
  lastCheck: XrayCheck | null;
  outbound: XrayExitView | null;
  /** Все выходы по порядку: основной, затем запасные. */
  exits: XrayExitView[];
  /** Запасные: когда готовились и что не вышло по серверам. */
  spares: { at: string | null; errors: { server: string; error: string }[] };
}

/** Выход, через который можно сделать запрос: undici-диспетчер его HTTP-входа. */
export interface XrayRoute {
  serverId: string;
  serverName: string;
  dispatcher: ProxyAgent;
}

const SETTING_KEY = 'xray_outbound';
const SPARES_KEY = 'xray_spares';
const BASE_PORT = 3128;

export class XrayManager {
  private proc: ChildProcess | null = null;
  private outbound: XrayOutbound | null = null;
  private spares: XrayOutbound[] = [];
  private sparesInfo: XrayStatus['spares'] = { at: null, errors: [] };
  private startedAt: string | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  /** Итоги проверок по выходам (serverId). */
  private checks = new Map<string, XrayCheck>();
  /** Последний выход, через который запрос прошёл: его пробуем первым. */
  private preferred: string | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private agents = new Map<number, ProxyAgent>();
  private readonly bin: string;
  private readonly dir: string;

  constructor(
    private db: Db,
    dataDir: string,
    private log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
    bin = process.env.XRAY_BIN || '/usr/local/bin/xray',
  ) {
    this.bin = bin;
    this.dir = path.join(dataDir, 'xray');
  }

  /** Адрес HTTP-входа основного выхода (TG_PROXY_URL и т.п.). */
  get proxyUrl(): string {
    return `http://127.0.0.1:${BASE_PORT}`;
  }

  /** Все выходы: основной первым, затем запасные (без сервера основного). */
  exits(): XrayOutbound[] {
    if (!this.outbound) return [];
    const primary = this.outbound;
    return [primary, ...this.spares.filter((x) => x.serverId !== primary.serverId)];
  }

  private running(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null);
  }

  private agentFor(i: number): ProxyAgent {
    let a = this.agents.get(i);
    if (!a) {
      a = new ProxyAgent(`http://127.0.0.1:${BASE_PORT + i}`);
      this.agents.set(i, a);
    }
    return a;
  }

  /**
   * Выходы для запроса по порядку: последний рабочий, затем остальные - сначала те, чья
   * последняя проверка прошла (по времени ответа), потом непроверенные, упавшие - в конце.
   * Пусто, если xray не запущен.
   */
  routes(): XrayRoute[] {
    if (!this.running()) return [];
    const list = this.exits().map((x, i) => ({
      serverId: x.serverId,
      serverName: x.serverName,
      dispatcher: this.agentFor(i),
      order: i,
    }));
    const rank = (r: (typeof list)[number]) => {
      if (r.serverId === this.preferred) return -1;
      const c = this.checks.get(r.serverId);
      return !c ? 1 : c.ok ? 0 : 2;
    };
    return list
      .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
      .map(({ order: _, ...r }) => r);
  }

  /** Запрос через выход прошёл: он первый в следующий раз. */
  worked(serverId: string) {
    this.preferred = serverId;
  }

  /** Диспетчер первого выхода по порядку routes(); null, если xray не запущен. */
  dispatcher(): ProxyAgent | null {
    return this.routes()[0]?.dispatcher ?? null;
  }

  hasBinary(): boolean {
    return existsSync(this.bin);
  }

  async load(): Promise<XrayOutbound | null> {
    this.spares = getJsonSetting<XrayOutbound[]>(this.db, SPARES_KEY, []);
    const raw = getSetting(this.db, SETTING_KEY);
    if (raw === undefined) return null;
    // выход выключали - пустая строка
    this.outbound = getJsonSetting<XrayOutbound | null>(this.db, SETTING_KEY, null);
    return this.outbound;
  }

  async save(ob: XrayOutbound | null) {
    this.outbound = ob;
    putSetting(this.db, SETTING_KEY, ob ? JSON.stringify(ob) : '');
    // выход выключен - запасные тоже не нужны
    if (!ob) await this.setSpares([], []);
  }

  /** Запасные выходы (routes/xray.ts готовит их сам); true - набор изменился (нужен перезапуск). */
  async setSpares(list: XrayOutbound[], errors: { server: string; error: string }[]) {
    const key = (l: XrayOutbound[]) =>
      JSON.stringify(l.map(({ updatedAt: _, serverName: __, ...x }) => x));
    const changed = key(list) !== key(this.spares);
    this.spares = list;
    this.sparesInfo = { at: new Date().toISOString(), errors };
    putSetting(this.db, SPARES_KEY, JSON.stringify(list));
    return changed;
  }

  /** Сервер сменил IP: выходы через него - на новый адрес, xray перезапускается. */
  async retarget(serverId: string, address: string): Promise<boolean> {
    let changed = false;
    if (this.outbound?.serverId === serverId && this.outbound.address !== address) {
      this.outbound = { ...this.outbound, address };
      putSetting(this.db, SETTING_KEY, JSON.stringify(this.outbound));
      changed = true;
    }
    if (this.spares.some((x) => x.serverId === serverId && x.address !== address)) {
      this.spares = this.spares.map((x) => (x.serverId === serverId ? { ...x, address } : x));
      putSetting(this.db, SPARES_KEY, JSON.stringify(this.spares));
      changed = true;
    }
    if (changed) await this.start();
    return changed;
  }

  private view(x: XrayOutbound, primary: boolean): XrayExitView {
    const { uuid, publicKey: _, shortId: __, ...rest } = x;
    return {
      ...rest,
      uuid: `${uuid.slice(0, 8)}...`,
      primary,
      lastCheck: this.checks.get(x.serverId) ?? null,
    };
  }

  status(): XrayStatus {
    const running = this.running();
    const exits = this.exits().map((x, i) => this.view(x, i === 0));
    return {
      configured: Boolean(this.outbound),
      binary: this.hasBinary(),
      running,
      pid: running ? (this.proc?.pid ?? null) : null,
      startedAt: running ? this.startedAt : null,
      restarts: this.restarts,
      lastError: this.lastError,
      lastCheck: exits[0]?.lastCheck ?? null,
      outbound: exits[0] ?? null,
      exits,
      spares: this.sparesInfo,
    };
  }

  private config(list: XrayOutbound[]) {
    return {
      log: { loglevel: 'warning' },
      inbounds: list.map((_, i) => ({
        tag: `in-${i}`,
        listen: '127.0.0.1',
        port: BASE_PORT + i,
        protocol: 'http',
        settings: {},
      })),
      outbounds: list.map((ob, i) => ({
        tag: `out-${i}`,
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: ob.address,
              port: ob.port,
              users: [{ id: ob.uuid, encryption: 'none', flow: ob.flow }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: ob.sni,
            fingerprint: ob.fingerprint,
            publicKey: ob.publicKey,
            shortId: ob.shortId,
            spiderX: '/',
          },
        },
      })),
      routing: {
        rules: list.map((_, i) => ({
          type: 'field',
          inboundTag: [`in-${i}`],
          outboundTag: `out-${i}`,
        })),
      },
    };
  }

  /** Запуск (или перезапуск) по сохранённым настройкам; при отсутствии настроек - остановка. */
  async start() {
    await this.stop();
    if (!this.outbound) return;
    if (!this.hasBinary()) {
      this.lastError = `не найден исполняемый файл xray (${this.bin})`;
      this.log.warn({ bin: this.bin }, 'xray: бинарник не найден');
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfg = path.join(this.dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(this.config(this.exits()), null, 2), { mode: 0o600 });
    this.spawn(cfg);
  }

  private spawn(cfg: string) {
    this.stopping = false;
    const p = spawn(this.bin, ['run', '-config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.closeAgents();
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trim();
        if (!t || t.includes('accepted')) continue;
        // "[Warning] core: Xray ... started" - не ошибка
        if (
          /\[Error\]|Failed|failed to/i.test(t) ||
          (/\[Warning\]/.test(t) && !/started/.test(t))
        ) {
          this.lastError = t.slice(0, 300);
        }
        this.log.info({ xray: t.slice(0, 300) }, 'xray');
      }
    };
    p.stdout?.on('data', onLine);
    p.stderr?.on('data', onLine);
    p.on('error', (e) => {
      this.lastError = e.message;
      this.log.warn({ err: e.message }, 'xray: не запустился');
    });
    p.on('exit', (code, signal) => {
      if (this.proc === p) this.proc = null;
      if (this.stopping) return;
      this.restarts += 1;
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.restarts, 5));
      this.lastError = this.lastError ?? `xray завершился (код ${code ?? signal})`;
      this.log.warn({ code, signal, delay }, 'xray: упал, перезапуск');
      this.restartTimer = setTimeout(() => {
        if (!this.stopping && this.outbound) this.spawn(cfg);
      }, delay);
    });
  }

  /** Диспетчеры прежнего процесса: соединения через него больше не живы. */
  private closeAgents() {
    for (const a of this.agents.values()) void a.close().catch(() => undefined);
    this.agents.clear();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const p = this.proc;
    this.proc = null;
    this.closeAgents();
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 3_000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }

  /**
   * Запрос наружу для любых заблокированных с хоста панели адресов: сначала напрямую с коротким
   * таймаутом, при сетевой ошибке - через выходы xray по порядку. Ответ сервера (любой код)
   * считается доставленным.
   */
  async fetch(url: string, init: RequestInit = {}, directTimeoutMs = 8_000): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(directTimeoutMs),
      });
    } catch (e) {
      let last = e;
      for (const r of this.routes()) {
        try {
          const res = await ufetch(url, {
            ...(init.method ? { method: init.method } : {}),
            ...(init.headers ? { headers: init.headers as Record<string, string> } : {}),
            ...(typeof init.body === 'string' ? { body: init.body } : {}),
            dispatcher: r.dispatcher,
            signal: AbortSignal.timeout(30_000),
          });
          this.worked(r.serverId);
          return res as unknown as Response;
        } catch (err) {
          last = err;
        }
      }
      throw last;
    }
  }

  /** Проверка одного выхода: запрос к api.telegram.org через его вход с замером времени. */
  private async checkOne(i: number, x: XrayOutbound): Promise<XrayCheck> {
    const at = new Date().toISOString();
    const t = Date.now();
    let c: XrayCheck;
    try {
      const res = await ufetch('https://api.telegram.org/', {
        dispatcher: this.agentFor(i),
        signal: AbortSignal.timeout(15_000),
      });
      await res.arrayBuffer();
      c = { at, ok: true, ms: Date.now() - t, err: null };
    } catch (e) {
      const err = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
      c = { at, ok: false, ms: Date.now() - t, err };
    }
    this.checks.set(x.serverId, c);
    return c;
  }

  /** Проверить все выходы параллельно; итог основного - как раньше (кнопка "Проверить"). */
  async checkAll(): Promise<XrayCheck[]> {
    if (!this.running()) {
      const at = new Date().toISOString();
      const c = { at, ok: false, ms: 0, err: 'xray не запущен' };
      for (const x of this.exits()) this.checks.set(x.serverId, c);
      return this.exits().map(() => c);
    }
    return Promise.all(this.exits().map((x, i) => this.checkOne(i, x)));
  }

  /** Проверка основного выхода (после настройки) - и заодно всех остальных. */
  async check(): Promise<XrayCheck> {
    const all = await this.checkAll();
    return all[0] ?? { at: new Date().toISOString(), ok: false, ms: 0, err: 'выход не настроен' };
  }
}
