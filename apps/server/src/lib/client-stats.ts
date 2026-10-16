import type {
  ClientStatsSnapshot,
  GLiveBinding,
  GLiveServer,
  GLiveState,
  GService,
} from '@vps/protocol';
import type { AgentRegistry } from '../agents/registry.js';
import { awgRef } from './gclient-services.js';

/**
 * Живая статистика клиентов: снимок clients.stats сервера один на всех смотрящих, не чаще раза в
 * SNAPSHOT_TTL_MS. Скорость - разница счётчиков за RATE_WINDOW_MS: 3X-UI обновляет их раз в 5 с,
 * WDTT - раз в 10 с, с окном короче скорость скакала бы между нулём и двойной.
 */

export const SNAPSHOT_TTL_MS = 2_500;
/** Снимки старше этого (от последнего) не храним: скорость по ним - уже не "сейчас". */
export const KEEP_MS = 40_000;
/** Меньше этого между снимками - скорость не считаем (деление на почти ноль). */
const MIN_DT_MS = 2_000;
export const RATE_WINDOW_MS: Record<GService, number> = {
  xui: 10_000,
  wdtt: 20_000,
  awg: 6_000,
  mtproxyl: 6_000,
  openflux: 6_000,
  naive: 6_000,
};
/** AWG: на связи, если handshake не старше 3 минут (WireGuard обновляет его раз в 2). */
const AWG_ONLINE_SEC = 180;

export interface Sample {
  /** время снимка на сервере, мс: разница между снимками - по часам одного сервера */
  at: number;
  snap: ClientStatsSnapshot;
}

/** Привязка для расчёта: key - ключ записи (у WDTT - wdttKey пароля, у остальных - ref). */
export interface LiveRef {
  id: string;
  service: GService;
  ref: string;
  key: string;
}

type Counters = { in: number; out: number } | null;

/** Счётчики записи в снимке: байты от клиента (in) и к клиенту (out); нет записи - null. */
export function counters(snap: ClientStatsSnapshot, b: LiveRef): Counters {
  switch (b.service) {
    case 'xui': {
      const s = snap.xui?.[b.key];
      return s ? { in: s.up, out: s.down } : null;
    }
    case 'awg': {
      const { container, publicKey } = awgRef(b.ref);
      const p = snap.awg?.[container]?.[publicKey];
      return p ? { in: p.rx, out: p.tx } : null;
    }
    case 'mtproxyl': {
      // telemt пишет в метрики только тех, кто подключался с его запуска: нет - значит ноль
      if (!snap.mtproxyl) return null;
      const u = snap.mtproxyl[b.key];
      return { in: u?.in ?? 0, out: u?.out ?? 0 };
    }
    case 'wdtt': {
      const w = snap.wdtt?.[b.key];
      return w ? { in: w.up, out: w.down } : null;
    }
    default:
      return null;
  }
}

/**
 * Скорость (байт/с) по последнему снимку и снимку не меньше окна назад (если такого ещё нет -
 * самому старому). Обнулился счётчик (перезапуск сервиса) или записи не было - null.
 */
export function rates(samples: Sample[], b: LiveRef): { in: number | null; out: number | null } {
  const none = { in: null, out: null };
  const cur = samples.at(-1);
  if (!cur || samples.length < 2) return none;
  const window = RATE_WINDOW_MS[b.service];
  let base: Sample | undefined;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i] as Sample;
    base = s;
    if (cur.at - s.at >= window) break;
  }
  if (!base) return none;
  const dt = cur.at - base.at;
  if (dt < MIN_DT_MS) return none;
  const a = counters(base.snap, b);
  const z = counters(cur.snap, b);
  if (!a || !z) return none;
  const one = (from: number, to: number) => (to < from ? null : ((to - from) * 1000) / dt);
  return { in: one(a.in, z.in), out: one(a.out, z.out) };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Живая статистика привязки по снимкам её сервера (последний - текущий). */
export function liveBinding(b: LiveRef, samples: Sample[]): GLiveBinding {
  const out: GLiveBinding = {
    bindingId: b.id,
    state: 'missing',
    lastSeen: null,
    rateIn: null,
    rateOut: null,
    totalIn: null,
    totalOut: null,
    sinceStart: false,
    conns: null,
    ips: null,
    devices: null,
    note: '',
  };
  const cur = samples.at(-1);
  if (!cur) return out;
  const snap = cur.snap;
  const set = (state: GLiveState, note = '') => {
    out.state = state;
    out.note = note;
    return out;
  };
  const down = (section: string, fallback: string) => set('down', snap.errors[section] ?? fallback);
  const withCounters = () => {
    const c = counters(snap, b);
    if (c) {
      out.totalIn = c.in;
      out.totalOut = c.out;
    }
    const r = rates(samples, b);
    out.rateIn = r.in;
    out.rateOut = r.out;
  };

  switch (b.service) {
    case 'xui': {
      if (!snap.xui) return down('xui', '3X-UI не отвечает');
      const s = snap.xui[b.key];
      if (!s) return set('missing', 'клиента нет в 3X-UI: ждёт синхронизации');
      withCounters();
      if (s.lastOnline > 0) out.lastSeen = iso(s.lastOnline);
      return set(s.online ? 'online' : s.lastOnline > 0 ? 'idle' : 'never');
    }
    case 'awg': {
      const { container, publicKey } = awgRef(b.ref);
      if (!publicKey) return set('missing', 'пир ещё не создан');
      if (!snap.awg) return down('awg', 'AWG не отвечает');
      const peers = snap.awg[container];
      if (!peers) return set('down', `контейнер ${container} не запущен`);
      const p = peers[publicKey];
      if (!p) return set('missing', 'пира нет на сервере: ждёт синхронизации');
      withCounters();
      out.sinceStart = true;
      if (p.handshake > 0) out.lastSeen = iso(p.handshake * 1000);
      if (p.handshake === 0) return set('never');
      return set(snap.at / 1000 - p.handshake < AWG_ONLINE_SEC ? 'online' : 'idle');
    }
    case 'mtproxyl': {
      if (!snap.mtproxyl) return down('mtproxyl', 'MTProxy не отвечает');
      const u = snap.mtproxyl[b.key];
      withCounters();
      out.sinceStart = true;
      out.conns = u?.conns ?? 0;
      out.ips = u?.ips ?? 0;
      return set(out.conns > 0 ? 'online' : 'idle');
    }
    case 'wdtt': {
      if (!snap.wdtt) return down('wdtt', 'WDTT не отвечает');
      const w = b.key ? snap.wdtt[b.key] : undefined;
      if (!w) return set('missing', 'пароля нет на сервере: ждёт синхронизации');
      withCounters();
      out.devices = w.devices;
      return set(w.devices > 0 ? 'online' : 'idle');
    }
    case 'openflux': {
      if (!snap.openflux) return down('openflux', 'OpenFlux не отвечает');
      const ch = snap.openflux[b.key];
      if (!ch) return set('missing', 'канала нет на сервере: ждёт синхронизации');
      if (!ch.active) return set('down', 'канал остановлен');
      out.conns = ch.conns;
      if (ch.conns > 0) return set('online', 'прямое подключение');
      return set('running', 'канал работает; подключения через документы и cups.online не видны');
    }
    case 'naive': {
      if (snap.naive === undefined) return down('naive', 'прокси для браузера не отвечает');
      if (!snap.naive) return set('down', 'служба не работает');
      return set('running', 'служба работает; подключения не видны');
    }
  }
  return out;
}

/** То же с учётом сервера: не в сети, агент устарел, снимок не получен. */
export function liveOnServer(
  b: LiveRef,
  s: { info: GLiveServer; samples: Sample[] },
): GLiveBinding {
  const empty = liveBinding(b, []);
  if (!s.info.online) return { ...empty, state: 'offline', note: 'сервер не в сети' };
  if (s.info.outdated)
    return { ...empty, state: 'outdated', note: 'агент устарел: нужно обновить агент' };
  if (s.info.error) return { ...empty, state: 'down', note: `агент не ответил: ${s.info.error}` };
  return liveBinding(b, s.samples);
}

interface ServerState {
  samples: Sample[];
  fetchedAt: number;
  error: string;
  inflight: Promise<void> | null;
}

type Registry = Pick<AgentRegistry, 'isOnline' | 'supports' | 'request'>;

/** Снимки серверов: общий кэш на процесс панели. */
export class ClientStatsHub {
  private states = new Map<string, ServerState>();

  constructor(
    private deps: {
      registry: Registry;
      /** токен API 3X-UI сервера (пусто - не выпущен) */
      xuiToken: (serverId: string) => string;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Снимки сервера (свежий - не старше SNAPSHOT_TTL_MS) и его состояние для ответа. */
  async server(serverId: string): Promise<{ info: GLiveServer; samples: Sample[] }> {
    const { registry } = this.deps;
    const info: GLiveServer = { serverId, online: false, outdated: false, at: null, error: '' };
    if (!registry.isOnline(serverId)) {
      this.states.delete(serverId);
      return { info, samples: [] };
    }
    info.online = true;
    if (!registry.supports(serverId, 'clients.stats')) {
      info.outdated = true;
      return { info, samples: [] };
    }
    let st = this.states.get(serverId);
    if (!st) {
      st = { samples: [], fetchedAt: 0, error: '', inflight: null };
      this.states.set(serverId, st);
    }
    if (this.now() - st.fetchedAt >= SNAPSHOT_TTL_MS) {
      const s = st;
      s.inflight ??= this.fetch(serverId, s).finally(() => {
        s.inflight = null;
      });
      await s.inflight;
    }
    info.error = st.error;
    const last = st.samples.at(-1);
    if (last && !st.error) info.at = iso(last.at);
    return { info, samples: st.error ? [] : st.samples };
  }

  private async fetch(serverId: string, st: ServerState) {
    try {
      const snap = await this.deps.registry.request<ClientStatsSnapshot>(
        serverId,
        'clients.stats',
        { xuiToken: this.deps.xuiToken(serverId) },
        { timeoutMs: 8_000 },
      );
      snap.errors ??= {};
      // часы сервера могли уйти назад (ntp) - начинаем отсчёт заново
      const prev = st.samples.at(-1);
      if (prev && snap.at <= prev.at) st.samples = [];
      st.samples.push({ at: snap.at, snap });
      st.samples = st.samples.filter((s) => snap.at - s.at <= KEEP_MS).slice(-40);
      st.error = '';
    } catch (e) {
      st.error = e instanceof Error ? e.message : String(e);
      st.samples = [];
    } finally {
      st.fetchedAt = this.now();
    }
  }
}
