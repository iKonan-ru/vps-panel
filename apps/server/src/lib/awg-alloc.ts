import { randomInt } from 'node:crypto';
import type { AgentRegistry } from '../agents/registry.js';
import { patchStatusCache } from '../agents/state.js';

import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';

/**
 * Порт и подсеть для нового экземпляра AWG. Подсеть выбирается по
 * всем экземплярам всех серверов: конфиги с разных серверов на одном устройстве (роутере)
 * не должны иметь одну подсеть. Серверы не в сети - по последнему известному (statusCache).
 */

interface AwgBrief {
  instances?: { container: string; port: number; address: string }[];
}

/** Сеть /24 адреса вида "10.8.1.0/24" или "10.8.1.0/24, fd42::/64" -> "10.8.1". */
function net24(address: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)\.\d+\/\d+/.exec(address);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Первая свободная 10.8.N.0 (N от 1): так же, как у приложения Amnezia, но без повторов. */
export function pickSubnet(used: Set<string>): string {
  for (let n = 1; n < 255; n++) if (!used.has(`10.8.${n}`)) return `10.8.${n}.0`;
  for (let n = 0; n < 255; n++) if (!used.has(`10.9.${n}`)) return `10.9.${n}.0`;
  return '10.10.0.0';
}

/** Случайный порт из 30000-59999, не занятый на сервере. */
export function pickPort(used: Set<number>): string {
  for (let i = 0; i < 200; i++) {
    const p = randomInt(30000, 60000);
    if (!used.has(p)) return String(p);
  }
  // почти всё занято - берём первый свободный подряд
  for (let p = 30000; p < 60000; p++) if (!used.has(p)) return String(p);
  return '55424';
}

export async function awgLiveDefaults(
  db: Db,
  registry: AgentRegistry,
  serverId: string,
): Promise<Record<string, string>> {
  const rows = await db.select().from(servers);
  const usedNets = new Set<string>();
  const usedPorts = new Set<number>();
  let hasMain = false;
  await Promise.all(
    rows.map(async (row) => {
      const cache = row.statusCache ?? {};
      let subnets = cache.awgSubnets ?? [];
      let st: AwgBrief | null = null;
      if (registry.isOnline(row.id)) {
        try {
          st = await registry.request<AwgBrief>(row.id, 'awg.status', {}, { timeoutMs: 15_000 });
          subnets = (st.instances ?? []).map((i) => i.address).filter(Boolean);
          patchStatusCache(db, row.id, { awgSubnets: subnets });
        } catch {
          // агент не ответил - берём последнее известное
        }
      }
      for (const a of subnets) {
        const n = net24(a);
        if (n) usedNets.add(n);
      }
      if (row.id !== serverId) return;
      for (const i of st?.instances ?? []) {
        if (i.port) usedPorts.add(i.port);
        if (i.container === 'amnezia-awg2') hasMain = true;
      }
      const inv = cache.inventory;
      for (const l of inv?.firewall?.listeners ?? []) usedPorts.add(l.port);
      for (const c of inv?.containers ?? []) {
        if (c.name === 'amnezia-awg2') hasMain = true;
        for (const p of c.published) {
          const m = /:(\d+)->/.exec(p);
          if (m) usedPorts.add(Number(m[1]));
        }
      }
    }),
  );
  return {
    AWG_INSTANCE: hasMain ? 'extra' : 'main',
    AWG_SERVER_PORT: pickPort(usedPorts),
    AWG_SUBNET_IP: pickSubnet(usedNets),
  };
}
