import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { isPanelHost, panelAddresses } from './panel-host.js';

/** Сколько живёт разрешение, выданное командой установки (проверки и запуск). */
const PENDING_MS = 2 * 60 * 60_000;

/**
 * Имена сервисов на самом сервере панели, которым сертификат выпускает Caddy панели (443 и 80
 * держит она): прокси для браузера (naive). Caddy спрашивает /api/proxy/ask и при выпуске, и
 * при продлении. Разрешено: имя, которое команда установки только что запросила (на 2 часа),
 * и имя установленного прокси из снимка сервера панели - для продлений.
 */
export class PanelCerts {
  private pending = new Map<string, number>();
  /** Известные имена (разрешённые и из снимков): запросы к ним панель не обслуживает. */
  private names = new Set<string>();

  constructor(
    private db: Db,
    private panelUrl: string,
  ) {}

  allow(name: string) {
    const n = name.trim().toLowerCase();
    this.pending.set(n, Date.now() + PENDING_MS);
    this.names.add(n);
  }

  /** Имена прокси сервера панели из снимков. */
  private async installed(): Promise<string[]> {
    const ips = await panelAddresses(this.panelUrl);
    const rows = await this.db
      .select({ host: servers.host, cache: servers.statusCache })
      .from(servers);
    return rows
      .filter((r) => isPanelHost(r.host, r.cache?.inventory, ips))
      .flatMap((r) => r.cache?.inventory?.services ?? [])
      .filter((s) => s.kind === 'naive' && typeof s.details?.domain === 'string')
      .map((s) => String(s.details?.domain).toLowerCase());
  }

  async allowed(name: string): Promise<boolean> {
    const n = name.trim().toLowerCase();
    for (const [k, until] of this.pending) if (until < Date.now()) this.pending.delete(k);
    if (this.pending.has(n) || (await this.installed()).includes(n)) {
      this.names.add(n);
      return true;
    }
    return false;
  }

  /** Перечитать имена из снимков (старт панели, раз в 5 минут). */
  async refresh() {
    for (const n of await this.installed()) this.names.add(n);
  }

  /**
   * Запрос пришёл на имя сервиса сервера панели: панель на нём не отвечает (Caddy панели
   * держит сертификат этого имени, а проксирует всё в панель).
   */
  isCertHost(host: string | undefined): boolean {
    if (!host || host.startsWith('[')) return false;
    return this.names.has((host.split(':')[0] ?? '').toLowerCase());
  }
}
