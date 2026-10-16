import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
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
  /** Имя сервера в панели на момент копии. */
  serverName?: string;
  services: string[];
  /** Ответы команд каталога для сервера (без секретов): команда -> ответы. */
  answers: Record<string, Record<string, string>>;
  awg: BackupAwg[];
  clientHost: string | null;
}

/** Подсеть клиентов AWG (10.8.N.0) по адресу интерфейса. */
export const subnetOf = (address: string) => {
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
  const inv = row?.statusCache?.inventory;
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
    serverName: row?.name ?? '',
    services: [...new Set((inv?.services ?? []).map((s) => s.kind))],
    answers,
    awg,
    clientHost: row?.clientHost ?? null,
  };
}
