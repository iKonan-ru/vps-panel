import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import { PROLOGUE } from '../commands/util.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import type { Action, actionJournal } from './action-journal.js';
import { type GClients, queued } from './gclients.js';

/** Пустой адрес - IP сервера: его MTProxyL определяет сам, и он переживает смену IP. */
const MT_HOST_SCRIPT = `${PROLOGUE}
if [ -n "$MT_HOST" ]; then say "MTProxyL: адрес в ссылках - $MT_HOST"
else say "MTProxyL: адрес в ссылках - IP сервера"; fi
MTPROXYL_ASSUME_YES=1 MTPROXYL_NONINTERACTIVE=true mtproxyl settings set CUSTOM_IP "$MT_HOST"
mtproxyl settings list 2>/dev/null | grep -i custom_ip || true
`;

export function hasMtproxyl(db: Db, serverId: string): boolean {
  const row = db.select().from(servers).where(eq(servers.id, serverId)).get();
  const inv = row?.statusCache?.inventory;
  return inv?.services.some((s) => s.kind === 'mtproxyl') ?? false;
}

/** Адрес в ссылках MTProxyL - "Адрес для клиентов" сервера, вывод - в данное действие. */
export async function setMtproxylHost(
  registry: AgentRegistry,
  serverId: string,
  host: string,
  action: Pick<Action, 'id' | 'stream'>,
): Promise<void> {
  const r = await registry.request<{ exitCode: number }>(
    serverId,
    'command.run',
    {
      runId: action.id,
      script: MT_HOST_SCRIPT,
      env: { MT_HOST: host },
      files: {},
      cleanup: [],
      timeoutSec: 120,
    },
    { timeoutMs: 180_000, onStream: action.stream },
  );
  if (r.exitCode !== 0) throw new Error('MTProxyL: не удалось сменить адрес в ссылках');
}

export interface MtHostDeps {
  db: Db;
  registry: AgentRegistry;
  journal: ReturnType<typeof actionJournal>;
  gc: GClients;
}

function resyncServer(deps: MtHostDeps, serverId: string) {
  deps.db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, serverId)).run();
  deps.gc.kick();
}

/**
 * После смены "Адреса для клиентов": адрес в ссылках MTProxyL (действие mtproxyl:host), затем
 * синхронизация сервера - ссылки и конфиги клиентов с новым адресом. Возвращает id действия.
 */
export function applyClientHost(deps: MtHostDeps, serverId: string): string | null {
  const row = deps.db.select().from(servers).where(eq(servers.id, serverId)).get();
  if (!row || !hasMtproxyl(deps.db, serverId) || !deps.registry.isOnline(serverId)) {
    resyncServer(deps, serverId);
    return null;
  }
  const host = row.clientHost ?? '';
  try {
    return deps.journal.background(
      serverId,
      'mtproxyl:host',
      { host: host || null },
      (action) => setMtproxylHost(deps.registry, serverId, host, action),
      { after: () => resyncServer(deps, serverId) },
    );
  } catch {
    // сервер занят другим действием: ссылки MTProxyL останутся прежними до следующей смены
    resyncServer(deps, serverId);
    return null;
  }
}
