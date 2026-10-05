import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as ufetch } from 'undici';
import type { Db } from '../db/index.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';

/**
 * Выход панели в заблокированные сети (сейчас - Telegram): xray-клиент к VLESS-Reality
 * инбаунду 3x-ui на заграничном сервере. Бинарник xray лежит в образе панели, панель
 * запускает его как дочерний процесс, пишет конфиг в /data/xray и перезапускает при смене.
 * Внутри контейнера он отдаёт HTTP-прокси 127.0.0.1:3128.
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

export interface XrayStatus {
  configured: boolean;
  binary: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  lastCheck: { at: string; ok: boolean; ms: number; err: string | null } | null;
  outbound: (Omit<XrayOutbound, 'uuid'> & { uuid: string }) | null;
}

const SETTING_KEY = 'xray_outbound';
const PROXY_PORT = 3128;

export class XrayManager {
  private proc: ChildProcess | null = null;
  private outbound: XrayOutbound | null = null;
  private startedAt: string | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  private lastCheck: XrayStatus['lastCheck'] = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private agent: ProxyAgent | null = null;
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

  get proxyUrl(): string {
    return `http://127.0.0.1:${PROXY_PORT}`;
  }

  /** Диспетчер undici для запросов через прокси; null, если xray не запущен. */
  dispatcher(): ProxyAgent | null {
    if (!this.proc || this.proc.exitCode !== null) return null;
    if (!this.agent) this.agent = new ProxyAgent(this.proxyUrl);
    return this.agent;
  }

  hasBinary(): boolean {
    return existsSync(this.bin);
  }

  async load(): Promise<XrayOutbound | null> {
    const raw = getSetting(this.db, SETTING_KEY);
    if (raw === undefined) return null;
    // выход выключали - пустая строка
    this.outbound = getJsonSetting<XrayOutbound | null>(this.db, SETTING_KEY, null);
    return this.outbound;
  }

  async save(ob: XrayOutbound | null) {
    this.outbound = ob;
    putSetting(this.db, SETTING_KEY, ob ? JSON.stringify(ob) : '');
  }

  status(): XrayStatus {
    const running = Boolean(this.proc && this.proc.exitCode === null);
    return {
      configured: Boolean(this.outbound),
      binary: this.hasBinary(),
      running,
      pid: running ? (this.proc?.pid ?? null) : null,
      startedAt: running ? this.startedAt : null,
      restarts: this.restarts,
      lastError: this.lastError,
      lastCheck: this.lastCheck,
      outbound: this.outbound
        ? { ...this.outbound, uuid: `${this.outbound.uuid.slice(0, 8)}...` }
        : null,
    };
  }

  private config(ob: XrayOutbound) {
    return {
      log: { loglevel: 'warning' },
      inbounds: [
        { tag: 'http', listen: '127.0.0.1', port: PROXY_PORT, protocol: 'http', settings: {} },
      ],
      outbounds: [
        {
          tag: 'proxy',
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
        },
      ],
    };
  }

  /** Запуск (или перезапуск) по сохранённым настройкам; при отсутствии настроек - остановка. */
  async start() {
    await this.stop();
    if (!this.outbound) return;
    if (!this.hasBinary()) {
      this.lastError = `нет бинарника xray (${this.bin})`;
      this.log.warn({ bin: this.bin }, 'xray: бинарник не найден');
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfg = path.join(this.dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(this.config(this.outbound), null, 2), { mode: 0o600 });
    this.spawn(cfg);
  }

  private spawn(cfg: string) {
    this.stopping = false;
    const p = spawn(this.bin, ['run', '-config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.agent = null;
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

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const p = this.proc;
    this.proc = null;
    this.agent = null;
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
   * таймаутом, при сетевой ошибке - через xray. Ответ сервера (любой код) считается доставленным.
   */
  async fetch(url: string, init: RequestInit = {}, directTimeoutMs = 8_000): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(directTimeoutMs),
      });
    } catch (e) {
      const d = this.dispatcher();
      if (!d) throw e;
      const r = await ufetch(url, {
        ...(init.method ? { method: init.method } : {}),
        ...(init.headers ? { headers: init.headers as Record<string, string> } : {}),
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
        dispatcher: d,
        signal: AbortSignal.timeout(30_000),
      });
      return r as unknown as Response;
    }
  }

  /** Проверка: запрос к api.telegram.org через прокси с замером времени. */
  async check(): Promise<NonNullable<XrayStatus['lastCheck']>> {
    const at = new Date().toISOString();
    const d = this.dispatcher();
    if (!d) {
      this.lastCheck = { at, ok: false, ms: 0, err: 'xray не запущен' };
      return this.lastCheck;
    }
    const t = Date.now();
    try {
      const res = await ufetch('https://api.telegram.org/', {
        dispatcher: d,
        signal: AbortSignal.timeout(15_000),
      });
      await res.arrayBuffer();
      this.lastCheck = { at, ok: true, ms: Date.now() - t, err: null };
    } catch (e) {
      this.lastCheck = { at, ok: false, ms: Date.now() - t, err: (e as Error).message };
    }
    return this.lastCheck;
  }
}
