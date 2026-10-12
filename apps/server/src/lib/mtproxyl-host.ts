import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import { PROLOGUE } from '../commands/util.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import type { actionJournal } from './action-journal.js';
import { type GClients, queued } from './gclients.js';

/**
 * Адрес в ссылках MTProxyL (CUSTOM_IP) следует за "Адресом для клиентов" сервера: имя задано -
 * в ссылках имя, имя убрано - IP сервера (автоопределение MTProxyL, переживает смену IP).
 * Скрипт идёт действием на сервере (его вывод - на странице сервера), после него - синхронизация
 * клиентов сервера: ссылки и конфиги на личных страницах перевыпускаются с новым адресом.
 */
export const MT_HOST_SCRIPT = `${PROLOGUE}
if [ -n "$MT_HOST" ]; then say "MTProxyL: адрес в ссылках - $MT_HOST"
else say "MTProxyL: адрес в ссылках - IP сервера"; fi
MTPROXYL_ASSUME_YES=1 MTPROXYL_NONINTERACTIVE=true mtproxyl settings set CUSTOM_IP "$MT_HOST"
mtproxyl settings list 2>/dev/null | grep -i custom_ip || true
say "Готово, дальше - синхронизация клиентов сервера"
`;

export interface MtHostDeps {
  db: Db;
  registry: AgentRegistry;
  journal: ReturnType<typeof actionJournal>;
  gc: GClients;
}

/** Синхронизация всех привязок сервера: адрес в ссылках и конфигах сменился. */
function resyncServer(deps: MtHostDeps, serverId: string) {
  deps.db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, serverId)).run();
  deps.gc.kick();
}

/**
 * После смены "Адреса для клиентов": MTProxyL на сервере есть и сервер в сети - сначала адрес в
 * ссылках MTProxyL (действие mtproxyl:host), затем синхронизация; иначе - сразу синхронизация.
 * Возвращает id действия MTProxyL или null.
 */
export function applyClientHost(deps: MtHostDeps, serverId: string): string | null {
  const row = deps.db.select().from(servers).where(eq(servers.id, serverId)).get();
  const inv = (row?.statusCache as StatusCache | null)?.inventory;
  const hasMt = inv?.services.some((s) => s.kind === 'mtproxyl') ?? false;
  if (!row || !hasMt || !deps.registry.isOnline(serverId)) {
    resyncServer(deps, serverId);
    return null;
  }
  const host = row.clientHost ?? '';
  let action: ReturnType<MtHostDeps['journal']['open']>;
  try {
    action = deps.journal.open(serverId, 'mtproxyl:host', { host: host || null });
  } catch {
    // сервер занят другим действием: ссылки MTProxyL останутся прежними до следующей смены
    resyncServer(deps, serverId);
    return null;
  }
  const done = (code: number) => {
    void action.finish(code);
    resyncServer(deps, serverId);
  };
  deps.registry
    .request<{ exitCode: number }>(
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
    )
    .then((r) => done(r.exitCode))
    .catch((e: Error) => {
      action.stream('stderr', `\nОШИБКА: ${e.message}\n`);
      done(1);
    });
  return action.id;
}
