import {
  type GLiveBinding,
  type GService,
  type WatchEvent,
  deviceLabel,
  serviceByBinding,
} from '@vps/protocol';
import { eq, inArray } from 'drizzle-orm';
import {
  type WatchState,
  clientWatches,
  gclientBindings,
  gclientDevices,
  gclients,
  servers,
} from '../db/schema.js';
import { type LiveDeps, clientLive } from './client-live.js';
import { schedule } from './schedule.js';
import { esc, tgSpan, tgWhen } from './telegram.js';

/** Как часто проверять связь клиентов с правилами. */
export const WATCH_POLL_MS = 60_000;
/**
 * Отключение подтверждается не раньше, чем панель сама видит клиента не на связи столько
 * времени (но не дольше задержки правила): две проверки подряд, а после перерыва (сервер не в
 * сети, сервис не отвечал) - время клиенту переподключиться.
 */
export const WATCH_SETTLE_MS = 2 * 60_000;

/** Что видно по привязкам правила сейчас. */
export interface Observation {
  status: 'up' | 'down' | 'unknown';
  /** последняя активность по данным сервиса, ISO */
  lastSeen: string | null;
  note: string;
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Связь по привязкам: на связи хотя бы одна - up; иначе хотя бы одна точно не на связи - down;
 * иначе unknown (сервер не в сети, сервис не отвечает, записи нет). OpenFlux, у которого
 * подключение не видно ("running"), не в счёт; прокси для браузера без отчёта расширения - не
 * на связи.
 */
export function observe(list: { service: GService; live: GLiveBinding }[]): Observation {
  if (!list.length) return { status: 'unknown', lastSeen: null, note: 'привязок нет' };
  let lastSeen: string | null = null;
  for (const { live } of list) lastSeen = later(lastSeen, live.lastSeen);
  if (list.some(({ live }) => live.state === 'online')) return { status: 'up', lastSeen, note: '' };
  const down = list.some(
    ({ service, live }) =>
      live.state === 'idle' ||
      live.state === 'never' ||
      (live.state === 'running' && service === 'naive'),
  );
  if (down) return { status: 'down', lastSeen, note: '' };
  const why = list.find(({ live }) => live.note)?.live.note ?? '';
  return { status: 'unknown', lastSeen, note: why || 'подключение не видно' };
}

/** Итог шага: новое состояние и что сообщить (null - ничего). */
export interface WatchStep {
  state: WatchState;
  send: { kind: 'down' | 'up'; forMs: number; lastSeen: string | null } | null;
}

/**
 * Шаг наблюдения по правилу. Первая проверка с известным состоянием - без сообщений. Отключён -
 * нет связи дольше задержки (от последней активности, а если она неизвестна - от начала
 * наблюдения) и панель видит это не меньше WATCH_SETTLE_MS (или задержки, если она короче).
 * unknown ничего не меняет: о сервере и сервисе сообщают свои уведомления.
 */
export function watchStep(
  prev: WatchState | null,
  obs: Observation,
  rule: { delayMinutes: number; event: WatchEvent },
  now: number,
): WatchStep {
  const at = new Date(now).toISOString();
  const delay = rule.delayMinutes * 60_000;
  const lastSeen = later(
    later(prev?.lastSeen ?? null, obs.lastSeen),
    obs.status === 'up' ? at : null,
  );
  const downSince =
    obs.status === 'down'
      ? prev?.status === 'down' && prev.downSince
        ? prev.downSince
        : at
      : null;
  const base = { status: obs.status, lastSeen, downSince, checkedAt: at, note: obs.note };
  const quietFor = (seen: string | null) => (seen ? now - Date.parse(seen) : null);

  if (!prev?.primed) {
    if (obs.status === 'unknown')
      return { state: { ...base, primed: false, offline: false }, send: null };
    const ago = quietFor(lastSeen);
    const offline = obs.status === 'down' && (ago === null || ago >= delay);
    return { state: { ...base, primed: true, offline }, send: null };
  }

  if (obs.status === 'up') {
    if (!prev.offline) return { state: { ...base, primed: true, offline: false }, send: null };
    const from = prev.lastSeen ?? prev.downSince;
    const forMs = from ? now - Date.parse(from) : 0;
    const send =
      rule.event === 'down' ? null : { kind: 'up' as const, forMs, lastSeen: prev.lastSeen };
    return { state: { ...base, primed: true, offline: false }, send };
  }

  if (obs.status === 'down' && !prev.offline) {
    const watched = now - Date.parse(downSince ?? at);
    const ago = quietFor(lastSeen);
    const confirmed =
      ago === null ? watched >= delay : ago >= delay && watched >= Math.min(delay, WATCH_SETTLE_MS);
    if (confirmed) {
      const send =
        rule.event === 'up' ? null : { kind: 'down' as const, forMs: ago ?? watched, lastSeen };
      return { state: { ...base, primed: true, offline: true }, send };
    }
  }
  return { state: { ...base, primed: true, offline: prev.offline }, send: null };
}

type Rule = typeof clientWatches.$inferSelect;

interface WatchDeps extends LiveDeps {
  telegram: { send: (text: string) => Promise<string | null> };
  /** адрес панели для ссылки на карточку клиента; пусто - без ссылки */
  panelUrl: string;
  log: { warn: (o: unknown, m?: string) => void };
  now?: () => number;
}

/**
 * Уведомления о подключении клиентов: раз в минуту - снимки серверов, на которых есть
 * включённые правила, шаг наблюдения по каждому правилу и сообщение в Telegram о переходе.
 * Правило явное: серверы, отключённые в общих уведомлениях, ему не мешают.
 */
export class ClientWatch {
  private running: Promise<void> | null = null;
  /** во время проверки попросили ещё одну (правило изменили) */
  private again = false;

  constructor(private deps: WatchDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): () => void {
    return schedule(() => void this.tick(), 20_000, WATCH_POLL_MS);
  }

  /** Проверка сейчас (новое или изменённое правило); во время идущей - ещё одна после неё. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run().catch((e: Error) =>
          this.deps.log.warn({ err: e.message }, 'client-watch: проверка'),
        );
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run() {
    const { db } = this.deps;
    const rules = db.select().from(clientWatches).where(eq(clientWatches.enabled, true)).all();
    if (!rules.length) return;
    const clientIds = [...new Set(rules.map((r) => r.clientId))];
    const clients = new Map(
      db
        .select()
        .from(gclients)
        .where(inArray(gclients.id, clientIds))
        .all()
        .map((c) => [c.id, c]),
    );
    for (const clientId of clientIds) {
      const c = clients.get(clientId);
      const mine = rules.filter((r) => r.clientId === clientId);
      if (!c || c.deletedAt || !c.enabled) {
        const note = !c || c.deletedAt ? 'клиент удалён' : 'клиент выключен';
        for (const r of mine) await this.apply(r, { status: 'unknown', lastSeen: null, note });
        continue;
      }
      const rows = db
        .select()
        .from(gclientBindings)
        .where(eq(gclientBindings.clientId, clientId))
        .all();
      const picked = new Map(mine.map((r) => [r.id, rows.filter((b) => matches(r, b))]));
      const need = rows.filter((b) => mine.some((r) => picked.get(r.id)?.includes(b)));
      const live = need.length ? await clientLive(this.deps, c, need) : { bindings: [] };
      const byId = new Map(live.bindings.map((l) => [l.bindingId, l]));
      for (const r of mine) {
        const list = (picked.get(r.id) ?? []).flatMap((b) => {
          const l = byId.get(b.id);
          return l ? [{ service: b.service as GService, live: l }] : [];
        });
        await this.apply(r, observe(list));
      }
    }
  }

  private async apply(r: Rule, obs: Observation) {
    const now = this.now();
    const step = watchStep(r.state ?? null, obs, r, now);
    this.deps.db
      .update(clientWatches)
      .set({ state: step.state })
      .where(eq(clientWatches.id, r.id))
      .run();
    if (!step.send) return;
    const err = await this.deps.telegram.send(this.message(r, step.send, now));
    if (err) this.deps.log.warn({ err, rule: r.id }, 'client-watch: не отправлено');
  }

  /** Текст: клиент (ссылкой на карточку), устройство, что случилось, сервис и сервер. */
  message(r: Rule, s: NonNullable<WatchStep['send']>, now = this.now()): string {
    const { db, panelUrl } = this.deps;
    const c = db
      .select({ name: gclients.name })
      .from(gclients)
      .where(eq(gclients.id, r.clientId))
      .get();
    let who = `<b>${esc(c?.name ?? r.clientId)}</b>`;
    if (panelUrl) {
      try {
        const href = new URL(`/clients/${encodeURIComponent(r.clientId)}`, panelUrl).href;
        who = `<a href="${esc(href).replace(/"/g, '&quot;')}">${who}</a>`;
      } catch {
        // адрес панели не разобрать - без ссылки
      }
    }
    if (r.deviceId) {
      const d = db.select().from(gclientDevices).where(eq(gclientDevices.id, r.deviceId)).get();
      if (d) who += `, ${esc(deviceLabel(d))}`;
    }
    const server = r.serverId
      ? (db.select({ name: servers.name }).from(servers).where(eq(servers.id, r.serverId)).get()
          ?.name ?? r.serverId)
      : null;
    const service = r.service ? (serviceByBinding(r.service)?.clientTitle ?? r.service) : null;
    const where =
      service && server
        ? `${service}, ${server}`
        : service
          ? `${service}, все серверы`
          : server
            ? `все сервисы, ${server}`
            : 'все сервисы и серверы';
    if (s.kind === 'down') {
      const seen = s.lastSeen ? `, последняя активность в ${tgWhen(s.lastSeen, now)}` : '';
      return `${who}\u00a0\u2014 нет связи ${tgSpan(s.forMs)} (${esc(where)})${seen}`;
    }
    return `${who}\u00a0\u2014 снова на связи (${esc(where)})${s.forMs > 0 ? `, не было ${tgSpan(s.forMs)}` : ''}`;
  }
}

/** Привязка подходит правилу: сервер, сервис и устройство совпадают или не заданы. */
export function matches(
  r: Pick<Rule, 'serverId' | 'service' | 'deviceId'>,
  b: { serverId: string; service: string; deviceId: string | null },
): boolean {
  return (
    (!r.serverId || r.serverId === b.serverId) &&
    (!r.service || r.service === b.service) &&
    (!r.deviceId || r.deviceId === b.deviceId)
  );
}
