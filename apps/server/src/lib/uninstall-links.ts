import { createHash } from 'node:crypto';
import type { UninstallConnections } from '@vps/protocol';
import { eq, isNull } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionLog, gclientBindings, servers } from '../db/schema.js';
import type { Action, actionJournal } from './action-journal.js';
import { busyAction } from './action-lock.js';
import { type Cascades, cleanupCascades } from './cascades.js';
import type { SecretBox } from './secret-box.js';
import { getSetting } from './settings.js';
import { EXIT_CLIENT, type XraySpares } from './xray-exits.js';
import { type XrayManager, setSpareOff, spareOff } from './xray.js';
import { unwrap } from './xui-api.js';
import { xuiFor } from './xui-token.js';

export const detachedKey = (id: string) => `uninstall_detached:${id}`;
export function panelDetachServers(db: Db, panelId: string) {
  return db
    .select()
    .from(servers)
    .all()
    .filter(
      (s) =>
        s.id !== panelId &&
        (s.agentTokenHash ||
          s.registrationToken ||
          getSetting(db, detachedKey(s.id)) !== `${s.host}:${s.sshPort}`),
    );
}

/** Связи снимаются до удаления файлов. Любая ошибка сохраняет сервер в панели. */
export class UninstallLinks {
  constructor(
    private d: {
      db: Db;
      registry: AgentRegistry;
      box: SecretBox;
      journal: ReturnType<typeof actionJournal>;
      cascades: Pick<Cascades, 'detachForCleanup'>;
      xray: Pick<XrayManager, 'exits' | 'save' | 'setSpares' | 'start' | 'status'>;
      spares: Pick<XraySpares, 'pauseForCleanup'>;
    },
  ) {}

  plan(serverId: string, panelHost = false): UninstallConnections {
    const { db, registry, xray } = this.d;
    const names = new Map(
      db
        .select()
        .from(servers)
        .all()
        .map((s) => [s.id, s.name]),
    );
    const rows = cleanupCascades(db, serverId);
    const items: UninstallConnections['items'] = rows.map((r) => ({
      id: r.id,
      title: `${r.telegram ? 'VLESS и Telegram' : 'VLESS'}: ${names.get(r.entryServerId) ?? r.entryServerId} -> ${names.get(r.exitServerId) ?? r.exitServerId}`,
      consequence:
        'Удалятся вход каскада, его маршруты Xray и служебный пользователь выхода. Ссылки этого каскада перестанут работать.',
      serverIds: [r.entryServerId, r.exitServerId],
    }));
    const exits = xray.exits().filter((x) => panelHost || x.serverId === serverId);
    const detach = panelHost ? panelDetachServers(db, serverId) : [];
    for (const s of detach)
      items.push({
        id: `detach:${s.id}`,
        title: `Отвязка сервера: ${s.name}`,
        consequence:
          'Агент и SSH-ключ панели удалятся после проверки нового пароля root. VPN-сервисы и их пользователи сохранятся; правила port-sync станут статическими.',
        serverIds: [s.id],
      });
    for (const x of exits)
      items.push({
        id: `panel-exit:${x.serverId}`,
        title: `Маршрут панели в Telegram: ${names.get(x.serverId) ?? x.serverName}`,
        consequence: panelHost
          ? 'Маршрут отключится, служебный пользователь панели удалится с выхода.'
          : 'Маршрут удалится. Основной выход переключится на оставшийся запасной, если он есть.',
        serverIds: [x.serverId],
      });
    const count = db
      .select()
      .from(gclientBindings)
      .where(eq(gclientBindings.serverId, serverId))
      .all().length;
    if (count)
      items.push({
        id: 'client-bindings',
        title: `Привязки клиентов на сервере: ${count}`,
        consequence: panelHost
          ? 'При очистке сервера панели удалится вся её база клиентов. Сохраните необходимые данные до запуска SSH-команды.'
          : 'После очистки привязки и ссылки этого сервера удалятся; сами клиенты и их другие серверы сохранятся.',
        serverIds: [],
      });
    const blockers: string[] = [];
    if (
      db
        .select()
        .from(actionLog)
        .where(isNull(actionLog.finishedAt))
        .all()
        .some((a) => a.kind === 'cascade:add' && a.params.exit === serverId)
    )
      blockers.push('Выполняется создание каскада через этот сервер; дождитесь завершения');
    for (const id of new Set(items.flatMap((i) => i.serverIds))) {
      if (!registry.isOnline(id))
        blockers.push(`Связанный сервер ${names.get(id) ?? id} не в сети`);
      if (id !== serverId && busyAction(db, id))
        blockers.push(`Связанный сервер ${names.get(id) ?? id} занят другим действием`);
    }
    // Проверки доступности и их время не меняют подтверждённый состав связей.
    const snapshot = [
      items,
      rows.map(({ check, telegramCheck, error, ...r }) => r),
      exits.map(({ updatedAt, ...x }) => x),
      detach.map((s) => [s.id, s.host, s.sshPort, s.agentTokenHash, s.registrationToken]),
    ];
    return {
      items,
      blockers,
      revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    };
  }

  /** Синхронная проверка и блокировка соседей: другие действия не вклинятся между ними. */
  lock(serverId: string, revision: string, panelHost = false): (ok: boolean) => Promise<void> {
    const plan = this.plan(serverId, panelHost);
    if (plan.revision !== revision)
      throw new Error('связи сервера изменились; проверьте состав очистки заново');
    if (plan.blockers.length) throw new Error(plan.blockers.join('; '));
    const actions: Action[] = [];
    for (const id of new Set(plan.items.flatMap((i) => i.serverIds)))
      if (id !== serverId) actions.push(this.d.journal.open(id, 'server.detach', { serverId }));
    return async (ok) => {
      await Promise.all(
        actions.map((a) =>
          a.finish(
            ok ? 0 : 1,
            ok ? 'Связи сняты' : 'Очистка не завершена; подробности в действии основного сервера',
          ),
        ),
      );
    };
  }

  async detach(serverId: string, say: (line: string) => void, panelHost = false): Promise<void> {
    const { db, xray, spares, box, registry } = this.d;
    const resume = await spares.pauseForCleanup();
    try {
      await this.d.cascades.detachForCleanup(serverId, say);
      const all = xray.exits();
      const selected = all.filter((x) => panelHost || x.serverId === serverId);
      // Даже при частичной ошибке автоматическая сверка не создаёт снятый выход заново.
      setSpareOff(db, [...spareOff(db), serverId, ...selected.map((x) => x.serverId)]);
      if (!selected.length) return;
      for (const x of selected) {
        const api = xuiFor(db, box, registry, x.serverId);
        const clients = (unwrap(await api('GET', 'clients/list'), 'clients/list') ?? []) as {
          email: string;
        }[];
        if (clients.some((c) => c.email === EXIT_CLIENT))
          unwrap(await api('POST', `clients/del/${EXIT_CLIENT}`), 'clients/del');
        const after = (unwrap(await api('GET', 'clients/list'), 'clients/list') ?? []) as {
          email: string;
        }[];
        if (after.some((c) => c.email === EXIT_CLIENT))
          throw new Error('служебный пользователь панели остался на выходе');
        say(`Служебный выход панели снят: ${x.serverName}`);
      }
      const kept = all.filter((x) => !selected.includes(x));
      await xray.save(kept[0] ?? null);
      await xray.setSpares(kept.slice(1), []);
      await xray.start();
      if (kept.length && xray.status().lastError)
        throw new Error('не удалось запустить оставшийся маршрут панели');
      say(
        kept.length
          ? `Основной выход панели: ${kept[0]?.serverName}`
          : 'Маршрут панели в Telegram отключён',
      );
    } finally {
      resume();
    }
  }
}
