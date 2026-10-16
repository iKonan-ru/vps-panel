import {
  type Inventory,
  type NotifyEvent,
  type PanelRelease,
  type ServiceUpdate,
  type ServiceUpdateKind,
  serviceByKind,
} from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { daysToPayment, rollPaymentDate } from './billing.js';
import { schedule } from './schedule.js';
import { type Telegram, esc } from './telegram.js';

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
    const stopPayments = schedule(() => void this.checkPayments(), 30_000, 60 * 60_000);
    return () => {
      stopPayments();
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
    await this.tg.send(`Сервер ${await this.serverName(id)} не в сети ${minutes}\u00a0мин`);
  }

  private async notifyOnline(id: string) {
    if (!(await this.tg.wants('online', id))) return;
    await this.tg.send(`Сервер ${await this.serverName(id)} снова в сети`);
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
          await this.tg.send(`${name}: ${esc(s.title)} не работает${why}`);
        }
        next.set(key, d);
      } else if (was?.notified && (await this.tg.wants('serviceUp', id))) {
        const name = await this.serverName(id, serviceByKind(s.kind)?.tab);
        await this.tg.send(`${name}: ${esc(s.title)} снова работает`);
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
    if (!st.token || !st.chatId || st.mutedServers.includes(id)) {
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
      await this.tg.send(`${name}: fail2ban за час заблокировал адресов: ${delta} (${esc(jails)})`);
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
      );
    }
  }

  /** Доступность из России: цель не видна две проверки подряд или снова видна. */
  async reach(id: string, note: { key: string; text: string; back: boolean }) {
    if (!(await this.tg.wants(reachEvent(note.key, note.back), id))) return;
    // "снова виден" - только если о пропаже этой цели вообще уведомляем
    if (note.back && !(await this.tg.wants(reachEvent(note.key, false), id))) return;
    await this.tg.send(`${await this.serverName(id)}: ${note.text}`);
  }

  /** Новая версия самой панели (релиз GitHub в её канале), один раз на версию. */
  async panelRelease(r: PanelRelease) {
    if (!(await this.tg.wants('updPanel'))) return;
    await this.tg.send(
      `VPS Panel: вышла ${r.prerelease ? 'предварительная ' : ''}версия ${esc(r.version)}. Обновление: \u00abНастройки\u00bb\u00a0\u2014 \u00abВерсия панели\u00bb.\n${esc(r.url)}`,
    );
  }

  /** Новая версия установленного сервиса (3x-ui, Xray, MTProxyL), один раз на версию. */
  async serviceUpdate(id: string, u: ServiceUpdate) {
    if (!(await this.tg.wants(UPDATE_EVENT[u.kind], id))) return;
    await this.tg.send(
      `${await this.serverName(id)}: доступна версия ${u.title} ${esc(u.latest)}${u.current ? `, сейчас ${esc(u.current)}` : ''}. Кнопка \u00abОбновить\u00bb\u00a0\u2014 в блоке \u00abОбслуживание\u00bb.`,
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
      if (!r.nextPaymentAt || st.mutedServers.includes(r.id)) continue;
      const days = daysToPayment(r.nextPaymentAt, now);
      if (days > st.paymentDays || days < 0) continue;
      if (this.paymentNotified.get(r.id) === r.nextPaymentAt) continue;
      this.paymentNotified.set(r.id, r.nextPaymentAt);
      const when = days === 0 ? 'сегодня' : `через ${days}\u00a0дн.`;
      const price = r.price ? ` (${r.price} ${r.currency})` : '';
      await this.tg.send(
        `Оплата хостинга ${await this.serverName(r.id)}: ${shortDate(r.nextPaymentAt)}, ${when}${price}${r.providerUrl ? `\n${esc(r.providerUrl)}` : ''}`,
      );
    }
  }
}
