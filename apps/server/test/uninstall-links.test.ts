import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/index.js';
import { actionLog, cascades, servers } from '../src/db/schema.js';
import { actionJournal } from '../src/lib/action-journal.js';
import { busyAction } from '../src/lib/action-lock.js';
import { UninstallLinks } from '../src/lib/uninstall-links.js';

function setup() {
  const db = createDb(':memory:');
  db.insert(servers)
    .values([
      { id: 'a', name: 'Вход', host: '203.0.113.1' },
      { id: 'b', name: 'Выход', host: '203.0.113.2' },
      { id: 'c', name: 'Независимый', host: '203.0.113.3' },
    ])
    .run();
  db.insert(cascades)
    .values({ id: 'ab', entryServerId: 'a', exitServerId: 'b', exitInboundId: 7, telegram: true })
    .run();
  const online = new Set(['a', 'b', 'c']);
  const registry = { isOnline: (id: string) => online.has(id), refreshInventory: async () => {} };
  const journal = actionJournal(db, { broadcast: () => {} } as never, registry as never);
  const detachForCleanup = vi.fn(async () => {});
  const xray = {
    exits: () => [],
    save: vi.fn(),
    setSpares: vi.fn(),
    start: vi.fn(),
    status: () => ({ lastError: null }),
  };
  const resume = vi.fn();
  const links = new UninstallLinks({
    db,
    registry: registry as never,
    box: {} as never,
    journal,
    cascades: { detachForCleanup },
    xray: xray as never,
    spares: { pauseForCleanup: async () => resume },
  });
  return { db, links, online, journal, detachForCleanup, xray, resume };
}

describe('связи перед очисткой сервера', () => {
  it('показывает обе стороны и последствия, блокирует только участников', async () => {
    const { db, links } = setup();
    const plan = links.plan('b');
    expect(plan.items[0]?.title).toContain('Вход -> Выход');
    expect(plan.items[0]?.consequence).toContain('Ссылки этого каскада перестанут работать');
    const unlock = links.lock('b', plan.revision);
    expect(busyAction(db, 'a')?.kind).toBe('server.detach');
    expect(busyAction(db, 'c')).toBeNull();
    await unlock(true);
    expect(busyAction(db, 'a')).toBeNull();
  });

  it('новая связь после просмотра требует повторного подтверждения', () => {
    const { db, links } = setup();
    const old = links.plan('b');
    db.insert(cascades)
      .values({ id: 'cb', entryServerId: 'c', exitServerId: 'b', exitInboundId: 7 })
      .run();
    expect(() => links.lock('b', old.revision)).toThrow('связи сервера изменились');
    expect(db.select().from(actionLog).all()).toHaveLength(0);
  });

  it('офлайн или занятый сосед блокирует до первого изменения', async () => {
    const { db, links, online, journal, detachForCleanup } = setup();
    const plan = links.plan('b');
    online.delete('a');
    expect(() => links.lock('b', plan.revision)).toThrow('не в сети');
    online.add('a');
    const action = journal.open('a', 'backup.restore');
    expect(() => links.lock('b', plan.revision)).toThrow('занят');
    expect(detachForCleanup).not.toHaveBeenCalled();
    expect(db.select().from(cascades).all()).toHaveLength(1);
    await action.finish(0);
  });

  it('создаваемый каскад к серверу тоже блокирует, пока записи связи ещё нет', async () => {
    const { links, journal } = setup();
    const action = journal.open('c', 'cascade:add', { exit: 'b' });
    expect(links.plan('b').blockers).toContain(
      'Выполняется создание каскада через этот сервер; дождитесь завершения',
    );
    await action.finish(0);
  });

  it('ошибка строго останавливает снятие и освобождает фоновую сверку', async () => {
    const { db, links, detachForCleanup, resume, xray } = setup();
    detachForCleanup.mockRejectedValueOnce(new Error('связь не снята'));
    const unlock = links.lock('b', links.plan('b').revision);
    await expect(links.detach('b', () => {})).rejects.toThrow('связь не снята');
    await unlock(false);
    expect(resume).toHaveBeenCalledOnce();
    expect(xray.save).not.toHaveBeenCalled();
    expect(db.select().from(actionLog).get()?.exitCode).toBe(1);
    expect(db.select().from(servers).where(eq(servers.id, 'b')).get()).toBeTruthy();
  });
});

it('удаляет служебного клиента выхода и переключает панель на оставшийся сервер', async () => {
  const { SecretBox } = await import('../src/lib/secret-box.js');
  const { saveXuiToken } = await import('../src/lib/xui-token.js');
  const { db, journal, detachForCleanup } = setup();
  const box = new SecretBox('s'.repeat(40));
  await saveXuiToken(db, box, 'b', 'fixture-token');
  const clients = new Set(['vps-panel', 'owner']);
  const registry = {
    isOnline: () => true,
    request: vi.fn(async (_id, _method, p) => {
      if (p.path === 'clients/list')
        return {
          status: 200,
          data: { success: true, obj: [...clients].map((email) => ({ email })) },
        };
      if (p.path === 'clients/del/vps-panel') clients.delete('vps-panel');
      return { status: 200, data: { success: true } };
    }),
  };
  const primary = { serverId: 'b', serverName: 'Выход', updatedAt: 'now' };
  const spare = { serverId: 'c', serverName: 'Запасной', updatedAt: 'now' };
  const xray = {
    exits: () => [primary, spare],
    save: vi.fn(),
    setSpares: vi.fn(),
    start: vi.fn(),
    status: () => ({ lastError: null }),
  };
  const links = new UninstallLinks({
    db,
    box,
    registry: registry as never,
    journal,
    cascades: { detachForCleanup },
    xray: xray as never,
    spares: { pauseForCleanup: async () => () => {} },
  });
  await links.detach('b', () => {});
  expect(clients).toEqual(new Set(['owner']));
  expect(registry.request.mock.calls.every((c) => c[0] === 'b')).toBe(true);
  expect(xray.save).toHaveBeenCalledWith(spare);
  expect(xray.setSpares).toHaveBeenCalledWith([], []);
  expect(xray.start).toHaveBeenCalledOnce();
});
