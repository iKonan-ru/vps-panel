import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { commandDefaults, servers } from '../db/schema.js';

/** AWG сервера в копии: контейнер, версия, порт UDP и подсеть клиентов (10.8.N.0). */
export interface BackupAwg {
  container: string;
  version: string;
  port: number;
  subnet: string;
}

/**
 * Что стояло на сервере, когда делали копию: по нему настройка ставит те же сервисы с теми же
 * портами на чистый сервер, а затем раскладывает данные. Секретов нет: пароли - в самом
 * архиве (база 3X-UI, конфиги MTProxyL и WDTT).
 */
export interface BackupSetup {
  services: string[];
  /** Ответы команд каталога для сервера (без секретов): команда -> ответы. */
  answers: Record<string, Record<string, string>>;
  awg: BackupAwg[];
  clientHost: string | null;
}

/** Основной контейнер AWG; дополнительные - amnezia-awg2-<порт>. */
export const AWG_MAIN = 'amnezia-awg2';

const subnetOf = (address: string) => {
  const m = /(\d+)\.(\d+)\.(\d+)\.\d+\/\d+/.exec(address);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0` : '';
};

/** Снимок набора сервера для копии; AWG - живым опросом (сервер в сети: копию делает агент). */
export async function backupSnapshot(
  db: Db,
  registry: AgentRegistry,
  serverId: string,
): Promise<BackupSetup> {
  const row = db.select().from(servers).where(eq(servers.id, serverId)).get();
  const inv = (row?.statusCache as StatusCache | null)?.inventory;
  const answers: BackupSetup['answers'] = {};
  for (const d of db
    .select()
    .from(commandDefaults)
    .where(eq(commandDefaults.serverId, serverId))
    .all())
    answers[d.commandId] = d.answers;
  let awg: BackupAwg[] = [];
  try {
    const st = await registry.request<{
      instances?: { container: string; port: number; address: string; version?: string }[];
    }>(serverId, 'awg.status', {}, { timeoutMs: 60_000 });
    awg = (st.instances ?? []).map((i) => ({
      container: i.container,
      version: i.version ?? '',
      port: i.port,
      subnet: subnetOf(i.address),
    }));
  } catch {
    // нет AWG или старый агент: экземпляры восстановит форма по именам контейнеров
  }
  return {
    services: [...new Set((inv?.services ?? []).map((s) => s.kind))],
    answers,
    awg,
    clientHost: row?.clientHost ?? null,
  };
}

/**
 * Снимок старой копии (без setup в manifest): компоненты архива, ответы и AWG старого сервера,
 * если он ещё в панели. Чего не узнать (порт основного AWG без сервера) - значения по умолчанию.
 */
export function legacySnapshot(
  db: Db,
  manifest: Record<string, unknown>,
  oldServerId: string | null,
): BackupSetup {
  const comps = (Array.isArray(manifest.components) ? manifest.components : []) as {
    id?: string;
    containers?: string[];
  }[];
  const services = comps
    .map((c) => (c.id === 'amnezia' ? 'amnezia' : c.id))
    .filter(
      (k): k is string =>
        typeof k === 'string' && ['xui', 'wdtt', 'mtproxyl', 'amnezia'].includes(k),
    );
  const old = oldServerId
    ? db.select().from(servers).where(eq(servers.id, oldServerId)).get()
    : undefined;
  const answers: BackupSetup['answers'] = {};
  if (old)
    for (const d of db
      .select()
      .from(commandDefaults)
      .where(eq(commandDefaults.serverId, old.id))
      .all())
      answers[d.commandId] = d.answers;
  const containers = comps.find((c) => c.id === 'amnezia')?.containers ?? [];
  const cache = (old?.statusCache as StatusCache | null) ?? null;
  const awg = containers.map((name) => {
    const extra = /^amnezia-awg2-(\d+)$/.exec(name);
    const published = cache?.inventory?.containers
      .find((c) => c.name === name)
      ?.published.map((p) => /:(\d+)->/.exec(p)?.[1])
      .find(Boolean);
    const version = cache?.awgInstances?.find((i) => i.container === name)?.version ?? '';
    return {
      container: name,
      version,
      port: Number(extra?.[1] ?? published ?? 0),
      subnet: '',
    };
  });
  // старый сервер ещё в панели: его сервисы целиком (OpenFlux и прокси в архив не входят)
  const oldKinds = cache?.inventory?.services.map((s) => s.kind) ?? [];
  return {
    services: [...new Set([...services, ...oldKinds])],
    answers,
    awg,
    clientHost: old?.clientHost ?? null,
  };
}
