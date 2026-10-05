import type { Inventory } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { rollPaymentDate } from './billing.js';
import { schedule } from './schedule.js';
import type { ServiceUpdate } from './service-updates.js';
import { type Telegram, esc } from './telegram.js';

const OFFLINE_GRACE_MS = 3 * 60_000;
const STARTUP_QUIET_MS = 2 * 60_000;

/**
 * Уведомления в Telegram по событиям панели. Состояние держим в памяти, при старте
 * заполняем из status_cache, чтобы после перезапуска панели не рассылать всё заново.
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

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    private tg: Telegram,
  ) {}

  private async serverName(id: string): Promise<string> {
    const row = (
      await this.db
        .select({ name: servers.name, host: servers.host })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1)
    )[0];
    return row ? `<b>${esc(row.name)}</b> (${row.host})` : id;
  }

  /**
   * Подписка на события реестра; seed - снимки серверов из базы на момент старта. Возвращает
   * остановку таймеров (проверка оплат, ожидание офлайна).
   */
  bind(seed: { id: string; cache: StatusCache }[]) {
    for (const s of seed) {
      if (s.cache.inventory) this.remember(s.id, s.cache.inventory, true);
    }
    this.registry.on('offline', (id) => {
      const t = setTimeout(() => void this.onStillOffline(id), OFFLINE_GRACE_MS);
      this.offlineTimers.set(id, t);
    });
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

  private async onStillOffline(id: string) {
    this.offlineTimers.delete(id);
    if (this.registry.isOnline(id) || this.registry.isUpdating(id)) return;
    const st = await this.tg.settings();
    if (!st.events.offline) return;
    this.notifiedOffline.add(id);
    await this.tg.send(`Сервер ${await this.serverName(id)} не на связи уже 3 минуты.`);
  }

  private async notifyOnline(id: string) {
    const st = await this.tg.settings();
    if (!st.events.offline) return;
    await this.tg.send(`Сервер ${await this.serverName(id)} снова на связи.`);
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
  }

  private async onInventory(id: string, inv: Inventory) {
    const first = !this.highFindings.has(id);
    if (first || this.quiet()) {
      this.remember(id, inv, true);
      return;
    }
    const st = await this.tg.settings();
    const name = await this.serverName(id);

    // критичные замечания: новые и ушедшие
    const prev = this.highFindings.get(id) ?? new Set<string>();
    const cur = new Set(
      (inv.audit?.findings ?? []).filter((f) => f.severity === 'high').map((f) => f.text),
    );
    const appeared = [...cur].filter((t) => !prev.has(t));
    const gone = [...prev].filter((t) => !cur.has(t));
    this.highFindings.set(id, cur);
    if (st.events.audit) {
      if (appeared.length)
        await this.tg.send(
          `${name}: критичные замечания\n${appeared.map((t) => `- ${esc(t)}`).join('\n')}`,
        );
      if (gone.length)
        await this.tg.send(
          `${name}: замечания закрыты\n${gone.map((t) => `- ${esc(t)}`).join('\n')}`,
        );
    }

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
        .map((j) => `${j.name}: ${j.banned} в бане, всего ${j.totalBanned}`)
        .join('; ');
      await this.tg.send(`${name}: fail2ban забанил ${delta} адресов за час (${esc(jails)}).`);
    }
    this.bans.set(id, b);

    // обновления безопасности: появились (0 -> N), не чаще раза в сутки
    const pend = inv.audit?.pendingUpdates ?? 0;
    const prevPend = this.pendingUpdates.get(id) ?? 0;
    this.pendingUpdates.set(id, pend);
    if (
      st.events.updates &&
      pend > 0 &&
      prevPend === 0 &&
      now - (this.updatesNotifiedAt.get(id) ?? 0) > 24 * 60 * 60_000
    ) {
      this.updatesNotifiedAt.set(id, now);
      await this.tg.send(
        `${name}: ожидают установки обновления безопасности: ${pend}. Кнопка "Обновить пакеты" в карточке.`,
      );
    }
  }

  /** Новая версия установленного сервиса (3x-ui, MTProxyL), один раз на версию. */
  async serviceUpdate(id: string, u: ServiceUpdate) {
    const st = await this.tg.settings();
    if (!st.events.updates || !st.token) return;
    await this.tg.send(
      `${await this.serverName(id)}: доступно обновление ${u.title} ${esc(u.current)} -> ${esc(u.latest)}. Кнопка "Обновить" в блоке "Безопасность" на вкладке "Обзор".`,
    );
  }

  /**
   * Платежи хостингу: прошедшие даты сдвигаются на период оплаты, затем напоминание
   * за N дней до даты, один раз на дату.
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
    if (!st.events.updates || !st.token) return;
    for (const r of rows) {
      if (!r.nextPaymentAt) continue;
      const days = Math.ceil((new Date(r.nextPaymentAt).getTime() - now) / 86_400_000);
      if (days > st.paymentDays || days < 0) continue;
      if (this.paymentNotified.get(r.id) === r.nextPaymentAt) continue;
      this.paymentNotified.set(r.id, r.nextPaymentAt);
      const when = days === 0 ? 'сегодня' : `через ${days} дн`;
      const price = r.price ? ` (${r.price} ${r.currency})` : '';
      await this.tg.send(
        `Оплата хостинга ${await this.serverName(r.id)}: ${when}, ${r.nextPaymentAt.slice(0, 10)}${price}. ${r.providerUrl ? esc(r.providerUrl) : ''}`,
      );
    }
  }
}
