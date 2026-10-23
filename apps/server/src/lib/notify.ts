import {
  CPU_HIGH_MINUTES,
  type Inventory,
  type Metrics,
  type NotifyEvent,
  type PanelRelease,
  type ServiceUpdate,
  type ServiceUpdateKind,
  serviceByKind,
} from '@vps/protocol';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { loginAttempts, servers } from '../db/schema.js';
import { daysToPayment, rollPaymentDate } from './billing.js';
import { schedule } from './schedule.js';
import { getJsonSetting, putSetting } from './settings.js';
import { type Telegram, esc, tgSpan } from './telegram.js';

const STARTUP_QUIET_MS = 2 * 60_000;
/** Сервис считаем упавшим, если он down в снимках агента дольше этого (перезапуск - не падение). */
const SERVICE_DOWN_MS = 2 * 60_000;

const UPDATE_EVENT: Record<ServiceUpdateKind, NotifyEvent> = {
  xui: 'updXui',
  xray: 'updXray',
  mtproxyl: 'updMtproxyl',
  'mtproxyl-panel': 'updMtproxylPanel',
};

/** Дата платежа (полночь UTC) для текста: 22.10 в текущем году, иначе 22.10.2027. */
function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const dm = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? dm : `${dm}.${d.getUTCFullYear()}`;
}

/** Адрес карточки сервера в панели (с вкладкой) или пусто, если адрес панели не задан. */
export function serverHref(panelUrl: string, id: string, tab?: string): string {
  if (!panelUrl) return '';
  try {
    return new URL(`/servers/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`, panelUrl).href;
  } catch {
    return '';
  }
}

/** Имя сервера для сообщения: жирным, ссылкой на карточку в панели, и адрес. */
export function serverLabel(name: string, host: string, href: string): string {
  const b = `<b>${esc(name)}</b>`;
  return `${href ? `<a href="${esc(href).replace(/"/g, '&quot;')}">${b}</a>` : b} (${esc(host)})`;
}

/** Событие уведомления о доступности из России по ключу цели. */
export function reachEvent(key: string, back: boolean): NotifyEvent {
  if (back) return 'reachBack';
  if (key === 'ip') return 'reachAddr';
  if (key.startsWith('xui:')) return 'reachInbound';
  return 'reachMtproxy';
}

/**
 * Уведомления в Telegram по событиям панели. Состояние держим в памяти, при старте
 * заполняем из status_cache, чтобы после перезапуска панели не рассылать всё заново.
 * Что слать - по событиям из настроек (tg.wants: событие включено, сервер не отключён).
 * "Снова работает" шлём только после отправленного "пропал"/"упал".
 */
export class Notifier {
  private startedAt = Date.now();
  private offlineTimers = new Map<string, NodeJS.Timeout>();
  private notifiedOffline = new Set<string>();
  private highFindings = new Map<string, Set<string>>();
  private bans = new Map<string, { at: number; total: number; notifiedAt: number }>();
  private pendingUpdates = new Map<string, number>();
  private updatesNotifiedAt = new Map<string, number>();
  private paymentNotified = new Map<string, string>(); // serverId -> дата платежа, о которой сказали
  /** Загрузка CPU выше порога: с какого момента (по метрикам подряд). */
  private cpuSince = new Map<string, number>();
  private loginNotifiedAt = 0;
  /** Настройки на 30 с: метрики приходят часто (раз в 2 с, пока открыта панель). */
  private stCache: { at: number; v: Awaited<ReturnType<Telegram['settings']>> } | null = null;
  /** serverId -> сервис (kind:title) -> с какого момента down и сказали ли. */
  private downs = new Map<string, Map<string, { since: number; notified: boolean }>>();

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    private tg: Telegram,
    /** Адрес панели для ссылок на серверы (PANEL_PUBLIC_URL); пусто - без ссылок. */
    private panelUrl = '',
  ) {}

  /** Имя сервера ссылкой на его карточку; tab - вкладка, где разбираться с событием. */
  private async serverName(id: string, tab?: string): Promise<string> {
    const row = (
      await this.db
        .select({ name: servers.name, host: servers.host })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1)
    )[0];
    return row ? serverLabel(row.name, row.host, serverHref(this.panelUrl, id, tab)) : esc(id);
  }

  /**
   * Подписка на события реестра; seed - снимки серверов из базы на момент старта. Возвращает
   * остановку таймеров (проверка оплат, ожидание офлайна).
   */
  bind(seed: { id: string; cache: StatusCache }[]) {
    for (const s of seed) {
      if (s.cache.inventory) this.remember(s.id, s.cache.inventory, true);
    }
    this.registry.on('offline', (id) => void this.onOffline(id));
    this.registry.on('online', (id) => {
      const t = this.offlineTimers.get(id);
      if (t) clearTimeout(t);
      this.offlineTimers.delete(id);
      if (this.notifiedOffline.delete(id)) void this.notifyOnline(id);
    });
    this.registry.on('inventory', (id, inv) => void this.onInventory(id, inv));
    this.registry.on('metrics', (id, m) => void this.onMetrics(id, m).catch(() => undefined));
    const stopPayments = schedule(() => void this.checkPayments(), 30_000, 60 * 60_000);
    const stopLogins = schedule(
      () => void this.checkLogins().catch(() => undefined),
      60_000,
      5 * 60_000,
    );
    return () => {
      stopPayments();
      stopLogins();
      for (const t of this.offlineTimers.values()) clearTimeout(t);
    };
  }

  private quiet(): boolean {
    return Date.now() - this.startedAt < STARTUP_QUIET_MS;
  }

  async forget(id: string) {
    const st = await this.tg.settings();
    if (st.mutedServers.includes(id))
      await this.tg.save({ mutedServers: st.mutedServers.filter((x) => x !== id) });
    const t = this.offlineTimers.get(id);
    if (t) clearTimeout(t);
    this.offlineTimers.delete(id);
    this.notifiedOffline.delete(id);
    this.highFindings.delete(id);
    this.bans.delete(id);
    this.pendingUpdates.delete(id);
    this.updatesNotifiedAt.delete(id);
    this.paymentNotified.delete(id);
    this.downs.delete(id);
    this.cpuSince.delete(id);
    this.setFlag('disk', id, false);
    this.setFlag('cpu', id, false);
  }

  private exists(id: string): boolean {
    return Boolean(
      this.db.select({ id: servers.id }).from(servers).where(eq(servers.id, id)).get(),
    );
  }

  private async onOffline(id: string) {
    if (!this.exists(id)) return;
    const st = await this.tg.settings();
    const old = this.offlineTimers.get(id);
    if (old) clearTimeout(old);
    const t = setTimeout(
      () => void this.onStillOffline(id, st.offlineMinutes),
      st.offlineMinutes * 60_000,
    );
    this.offlineTimers.set(id, t);
  }

  private async onStillOffline(id: string, minutes: number) {
    this.offlineTimers.delete(id);
    if (!this.exists(id)) return;
    if (this.registry.isOnline(id) || this.registry.isUpdating(id)) return;
    if (!(await this.tg.wants('offline', id))) return;
    this.notifiedOffline.add(id);
    await this.tg.send(`Сервер ${await this.serverName(id)} не в сети ${minutes}\u00a0мин`, {
      meta: { event: 'offline', serverId: id, ref: `off:${id}` },
    });
  }

  /** Снова в сети: правится сообщение "не в сети" (без кнопок), время перерыва - от его отправки. */
  private async notifyOnline(id: string) {
    if (!(await this.tg.wants('online', id))) return;
    const name = await this.serverName(id);
    const { offlineMinutes } = await this.tg.settings();
    await this.tg.resolve(`off:${id}`, (at) => {
      const span = at
        ? `, не был в сети ${tgSpan(Date.now() - Date.parse(at) + offlineMinutes * 60_000)}`
        : '';
      return `\u2705 Сервер ${name} снова в сети${span}`;
    });
  }

  /** Сервисы из снимка: упал (down дольше SERVICE_DOWN_MS) и снова работает. */
  private async services(id: string, inv: Inventory) {
    const prev = this.downs.get(id) ?? new Map<string, { since: number; notified: boolean }>();
    const next = new Map<string, { since: number; notified: boolean }>();
    const now = Date.now();
    for (const s of inv.services) {
      const key = `${s.kind}:${s.title}`;
      const was = prev.get(key);
      if (s.details?.down === true) {
        const d = was ?? { since: now, notified: false };
        if (
          !d.notified &&
          now - d.since >= SERVICE_DOWN_MS &&
          (await this.tg.wants('serviceDown', id))
        ) {
          d.notified = true;
          const why =
            typeof s.details.downReason === 'string' ? `: ${esc(s.details.downReason)}` : '';
          const name = await this.serverName(id, serviceByKind(s.kind)?.tab);
          await this.tg.send(`${name}: ${esc(s.title)} не работает${why}`, {
            meta: {
              event: 'serviceDown',
              serverId: id,
              ref: `svc:${id}:${key}`,
              data: { kind: s.kind, title: s.title },
            },
          });
        }
        next.set(key, d);
      } else if (was?.notified && (await this.tg.wants('serviceUp', id))) {
        const name = await this.serverName(id, serviceByKind(s.kind)?.tab);
        await this.tg.resolve(`svc:${id}:${key}`, (at) => {
          const span = at
            ? `, не работал ${tgSpan(Date.now() - Date.parse(at) + SERVICE_DOWN_MS)}`
            : '';
          return `\u2705 ${name}: ${esc(s.title)} снова работает${span}`;
        });
      }
    }
    this.downs.set(id, next);
  }

  /** Запоминает состояние без уведомлений (старт панели или первый снимок сервера). */
  private remember(id: string, inv: Inventory, initial: boolean) {
    const high = new Set(
      (inv.audit?.findings ?? []).filter((f) => f.severity === 'high').map((f) => f.text),
    );
    this.highFindings.set(id, high);
    const total = (inv.audit?.jails ?? []).reduce((a, j) => a + j.totalBanned, 0);
    if (initial || !this.bans.has(id)) this.bans.set(id, { at: Date.now(), total, notifiedAt: 0 });
    this.pendingUpdates.set(id, inv.audit?.pendingUpdates ?? 0);
    if (initial) {
      // уже лежащие сервисы (старт панели, сервер отключён в уведомлениях): ни "упал",
      // ни "снова работает" - since бесконечность
      const down = new Map<string, { since: number; notified: boolean }>();
      for (const sv of inv.services)
        if (sv.details?.down === true)
          down.set(`${sv.kind}:${sv.title}`, { since: Number.POSITIVE_INFINITY, notified: false });
      this.downs.set(id, down);
    }
  }

  private async onInventory(id: string, inv: Inventory) {
    const first = !this.highFindings.has(id);
    if (first || this.quiet()) {
      this.remember(id, inv, true);
      return;
    }
    const st = await this.tg.settings();
    if (!st.token || !st.chatId || (await this.tg.isMuted(id))) {
      this.remember(id, inv, true);
      return;
    }
    await this.services(id, inv);
    const name = await this.serverName(id);

    // критичные замечания: новые и ушедшие
    const prev = this.highFindings.get(id) ?? new Set<string>();
    const cur = new Set(
      (inv.audit?.findings ?? []).filter((f) => f.severity === 'high').map((f) => f.text),
    );
    const appeared = [...cur].filter((t) => !prev.has(t));
    const gone = [...prev].filter((t) => !cur.has(t));
    this.highFindings.set(id, cur);
    if (st.events.auditNew && appeared.length)
      await this.tg.send(
        `${name}: критичные замечания\n${appeared.map((t) => `- ${esc(t)}`).join('\n')}`,
        { meta: { event: 'auditNew', serverId: id } },
      );
    if (st.events.auditClosed && gone.length)
      await this.tg.send(
        `${name}: замечания устранены\n${gone.map((t) => `- ${esc(t)}`).join('\n')}`,
      );

    // баны fail2ban: рост суммарного счётчика за последний час
    const total = (inv.audit?.jails ?? []).reduce((a, j) => a + j.totalBanned, 0);
    const b = this.bans.get(id) ?? { at: Date.now(), total, notifiedAt: 0 };
    const now = Date.now();
    if (now - b.at > 60 * 60_000) {
      b.at = now;
      b.total = total;
    }
    const delta = total - b.total;
    if (st.events.bans && delta >= st.banThreshold && now - b.notifiedAt > 60 * 60_000) {
      b.notifiedAt = now;
      const jails = (inv.audit?.jails ?? [])
        .map((j) => `${j.name}: сейчас ${j.banned}, всего ${j.totalBanned}`)
        .join('; ');
      await this.tg.send(
        `${name}: fail2ban за час заблокировал адресов: ${delta} (${esc(jails)})`,
        { meta: { event: 'bans', serverId: id } },
      );
    }
    this.bans.set(id, b);

    // обновления безопасности: появились (0 -> N), не чаще раза в сутки
    const pend = inv.audit?.pendingUpdates ?? 0;
    const prevPend = this.pendingUpdates.get(id) ?? 0;
    this.pendingUpdates.set(id, pend);
    if (
      st.events.pkgUpdates &&
      pend > 0 &&
      prevPend === 0 &&
      now - (this.updatesNotifiedAt.get(id) ?? 0) > 24 * 60 * 60_000
    ) {
      this.updatesNotifiedAt.set(id, now);
      await this.tg.send(
        `${name}: ожидают установки обновления безопасности: ${pend}. Кнопка \u00abОбновить\u00bb\u00a0\u2014 в блоке \u00abОбслуживание\u00bb.`,
        { meta: { event: 'pkgUpdates', serverId: id } },
      );
    }
  }

  private async cachedSettings() {
    if (!this.stCache || Date.now() - this.stCache.at > 30_000)
      this.stCache = { at: Date.now(), v: await this.tg.settings() };
    return this.stCache.v;
  }

  /** О каких серверах уже сказано "диск" и "CPU": переживает перезапуск панели. */
  private flags(): { disk: string[]; cpu: string[] } {
    return { disk: [], cpu: [], ...getJsonSetting(this.db, 'tg_notified', {}) };
  }
  private setFlag(kind: 'disk' | 'cpu', id: string, on: boolean) {
    const f = this.flags();
    const set = new Set(f[kind]);
    if (on) set.add(id);
    else set.delete(id);
    f[kind] = [...set];
    putSetting(this.db, 'tg_notified', JSON.stringify(f));
  }

  /**
   * Диск и CPU по метрикам: диск заполнен выше порога - одно сообщение, освободился (на 3%
   * ниже порога) - правка исходного; CPU выше порога CPU_HIGH_MINUTES минут подряд - одно
   * сообщение, спала - правка.
   */
  private async onMetrics(id: string, m: Metrics) {
    if (this.quiet()) return;
    const st = await this.cachedSettings();
    if (!st.token || !st.chatId) return;
    const f = this.flags();
    const pct = m.diskTotalGb > 0 ? Math.round((m.diskUsedGb / m.diskTotalGb) * 100) : 0;
    const diskOn = f.disk.includes(id);
    if (!diskOn && pct >= st.diskPercent) {
      this.setFlag('disk', id, true);
      if (await this.tg.wants('diskFull', id))
        await this.tg.send(
          `${await this.serverName(id)}: диск заполнен на ${pct}% (${Math.round(m.diskUsedGb)}/${Math.round(m.diskTotalGb)}"""+NBSP+"""ГБ)`,
          { meta: { event: 'diskFull', serverId: id, ref: `disk:${id}` } },
        );
    } else if (diskOn && pct < st.diskPercent - 3) {
      this.setFlag('disk', id, false);
      if (await this.tg.wants('diskFull', id)) {
        const name = await this.serverName(id);
        await this.tg.resolve(
          `disk:${id}`,
          () => `"""+OK+""" ${name}: место на диске освободилось, занято ${pct}%`,
        );
      }
    }
    const now = Date.now();
    const cpuOn = f.cpu.includes(id);
    if (m.cpuPercent >= st.cpuPercent) {
      const since = this.cpuSince.get(id) ?? now;
      this.cpuSince.set(id, since);
      if (!cpuOn && now - since >= CPU_HIGH_MINUTES * 60_000) {
        this.setFlag('cpu', id, true);
        if (await this.tg.wants('cpuHigh', id))
          await this.tg.send(
            `${await this.serverName(id)}: загрузка CPU выше ${st.cpuPercent}% уже ${CPU_HIGH_MINUTES}"""+NBSP+"""мин, сейчас ${Math.round(m.cpuPercent)}%, load ${m.load1.toFixed(2)}`,
            { meta: { event: 'cpuHigh', serverId: id, ref: `cpu:${id}` } },
          );
      }
    } else {
      this.cpuSince.delete(id);
      if (cpuOn) {
        this.setFlag('cpu', id, false);
        if (await this.tg.wants('cpuHigh', id)) {
          const name = await this.serverName(id);
          await this.tg.resolve(
            `cpu:${id}`,
            () => `"""+OK+""" ${name}: загрузка CPU спала, сейчас ${Math.round(m.cpuPercent)}%`,
          );
        }
      }
    }
  }

  /** Неудачные входы в панель за час: порог - одно сообщение, не чаще раза в час. */
  private async checkLogins() {
    if (!(await this.tg.wants('loginFails'))) return;
    const st = await this.tg.settings();
    const hour = new Date(Date.now() - 3600_000).toISOString();
    const rows = await this.db
      .select({ ip: loginAttempts.ip, n: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ok, false), gt(loginAttempts.at, hour)))
      .groupBy(loginAttempts.ip)
      .orderBy(desc(sql`count(*)`));
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    if (!total || !(total >= st.loginFails) || Date.now() - this.loginNotifiedAt < 3600_000) return;
    this.loginNotifiedAt = Date.now();
    const ips = rows
      .slice(0, 5)
      .map((r) => `<code>${esc(r.ip)}</code> (${r.n})`)
      .join(', ');
    await this.tg.send(`VPS Panel: неудачных попыток входа за час: ${total}\nАдреса: ${ips}`, {
      meta: { event: 'loginFails' },
    });
  }

  /** Доступность из России: цель не видна две проверки подряд или снова видна. */
  async reach(id: string, note: { key: string; text: string; back: boolean }) {
    if (!(await this.tg.wants(reachEvent(note.key, note.back), id))) return;
    // "снова виден" - только если о пропаже этой цели вообще уведомляем
    if (note.back && !(await this.tg.wants(reachEvent(note.key, false), id))) return;
    const name = await this.serverName(id);
    const ref = `reach:${id}:${note.key}`;
    if (note.back) {
      await this.tg.resolve(ref, () => `\u2705 ${name}: ${note.text}`);
      return;
    }
    await this.tg.send(`${name}: ${note.text}`, {
      meta: { event: reachEvent(note.key, false), serverId: id, ref, data: { key: note.key } },
    });
  }

  /** Каскад VLESS входа: выход не отвечает две проверки подряд или снова отвечает. */
  async cascade(id: string, text: string, back: boolean, cid = '') {
    if (!(await this.tg.wants(back ? 'serviceUp' : 'serviceDown', id))) return;
    if (back && !(await this.tg.wants('serviceDown', id))) return;
    const name = await this.serverName(id, 'xui');
    const ref = `casc:${cid || id}`;
    if (back) {
      await this.tg.resolve(ref, () => `\u2705 ${name}: ${esc(text)}`);
      return;
    }
    await this.tg.send(`${name}: ${esc(text)}`, {
      meta: { event: 'cascade', serverId: id, ref, data: cid ? { cid } : {} },
    });
  }

  /** Новая версия самой панели (релиз GitHub в её канале), один раз на версию. */
  async panelRelease(r: PanelRelease) {
    if (!(await this.tg.wants('updPanel'))) return;
    await this.tg.send(
      `VPS Panel: вышла ${r.prerelease ? 'предварительная ' : ''}версия ${esc(r.version)}. Обновление: \u00abНастройки\u00bb\u00a0\u2014 \u00abВерсия панели\u00bb.\n${esc(r.url)}`,
      { meta: { event: 'updPanel', data: { version: r.version, url: r.url } } },
    );
  }

  /** Новая версия установленного сервиса (3x-ui, Xray, MTProxyL), один раз на версию. */
  async serviceUpdate(id: string, u: ServiceUpdate) {
    if (!(await this.tg.wants(UPDATE_EVENT[u.kind], id))) return;
    await this.tg.send(
      `${await this.serverName(id)}: доступна версия ${u.title} ${esc(u.latest)}${u.current ? `, сейчас ${esc(u.current)}` : ''}. Кнопка \u00abОбновить\u00bb\u00a0\u2014 в блоке \u00abОбслуживание\u00bb.`,
      { meta: { event: UPDATE_EVENT[u.kind], serverId: id, data: { kind: u.kind } } },
    );
  }

  /**
   * Платежи хостингу: наступившие и прошедшие даты сдвигаются на период оплаты, затем
   * напоминание за N дней до даты, один раз на дату.
   */
  private async checkPayments() {
    const rows = await this.db.select().from(servers);
    const now = Date.now();
    for (const r of rows) {
      if (!r.nextPaymentAt) continue;
      const next = rollPaymentDate(r.nextPaymentAt, r.billingMonths, now);
      if (!next) continue;
      await this.db.update(servers).set({ nextPaymentAt: next }).where(eq(servers.id, r.id));
      r.nextPaymentAt = next;
    }
    const st = await this.tg.settings();
    if (!st.events.payment || !st.token || !st.chatId) return;
    for (const r of rows) {
      if (!r.nextPaymentAt || (await this.tg.isMuted(r.id))) continue;
      const days = daysToPayment(r.nextPaymentAt, now);
      if (days > st.paymentDays || days < 0) continue;
      if (this.paymentNotified.get(r.id) === r.nextPaymentAt) continue;
      this.paymentNotified.set(r.id, r.nextPaymentAt);
      const when = days === 0 ? 'сегодня' : `через ${days}\u00a0дн.`;
      const price = r.price ? ` (${r.price} ${r.currency})` : '';
      await this.tg.send(
        `Оплата хостинга ${await this.serverName(r.id)}: ${shortDate(r.nextPaymentAt)}, ${when}${price}${r.providerUrl ? `\n${esc(r.providerUrl)}` : ''}`,
        { meta: { event: 'payment', serverId: r.id } },
      );
    }
  }
}
