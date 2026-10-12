import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { Telegram } from '../src/lib/telegram.js';

type Deliver = (st: unknown, m: string) => Promise<{ err: string | null; via: string | null }>;
type Call = () => Promise<{ raw?: string; err?: string; via?: string }>;

async function make() {
  const n = new Telegram(createDb(':memory:'), new SecretBox('x'.repeat(32)), {} as never, {
    info: () => undefined,
    warn: () => undefined,
  });
  await n.save({ token: '1:t', chatId: '42' });
  return n;
}

describe('Telegram.send', () => {
  it('отправляет по порядку, у каждого вызова свой итог', async () => {
    const n = await make();
    const sent: string[] = [];
    (n as unknown as { deliver: Deliver }).deliver = async (_st, m) => {
      sent.push(m);
      return { err: null, via: 'direct' };
    };
    const res = await Promise.all([n.send('a'), n.send('b'), n.send('c')]);
    expect(res).toEqual([null, null, null]);
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(n.health()).toMatchObject({ ok: true, lastOkVia: 'direct', pending: 0 });
  });

  it('не доходит - копит; доставка вернулась - сводка и отложенное по порядку', async () => {
    const n = await make();
    let up = false;
    const sent: string[] = [];
    (n as unknown as { deliver: Deliver }).deliver = async (_st, m) => {
      if (!up) return { err: 'с хоста панели: fetch failed', via: null };
      sent.push(m);
      return { err: null, via: 'proxy:s2' };
    };
    (n as unknown as { call: Call }).call = async () =>
      up ? { raw: '{}', via: 'proxy:s2' } : { err: 'нет пути' };

    expect(await n.send('первое')).toBe('с хоста панели: fetch failed');
    // второе уже не пробует мёртвые пути: сразу в очередь
    expect(await n.send('второе')).toMatch(/отложено/);
    // тест из настроек не копится
    await n.send('тест', { keep: false });
    expect(n.health()).toMatchObject({
      ok: false,
      pending: 2,
      lastError: 'с хоста панели: fetch failed',
    });
    expect(n.health().failingSince).toBeTruthy();

    await n.probe();
    expect(n.health().ok).toBe(false);

    up = true;
    await n.probe();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatch(/не доходили с .* по .*Отложенных сообщений: 2/);
    expect(sent[1]).toMatch(/первое$/);
    expect(sent[2]).toMatch(/второе$/);
    expect(n.health()).toMatchObject({ ok: true, failingSince: null, pending: 0 });
  });
});

describe('Telegram: путь доставки', () => {
  it('агент - запасной: после настройки выхода xray через 10 минут снова основной', async () => {
    const routes: { serverId: string; serverName: string; dispatcher: never }[] = [];
    const n = new Telegram(
      createDb(':memory:'),
      new SecretBox('x'.repeat(32)),
      { onlineIds: () => ['fin'], request: async () => ({}) } as never,
      { info: () => undefined, warn: () => undefined },
      { routes: () => routes, worked: () => undefined },
    );
    // напрямую не доходит (панель в РФ), через выход xray - доходит
    (n as unknown as { direct: (...a: unknown[]) => Promise<unknown> }).direct = async (
      ...a: unknown[]
    ) => (a[3] ? { raw: '{"ok":true}' } : { err: 'timeout' });
    const call = () => n.call('1:t', 'sendMessage', { chat_id: '42', text: 'x' });
    expect((await call()).via).toBe('agent:fin');
    routes.push({ serverId: 'fin', serverName: 'Finland', dispatcher: {} as never });
    expect((await call()).via).toBe('agent:fin');
    const r = n as unknown as { route: { via: string; at: number } };
    r.route.at -= 11 * 60_000;
    expect((await call()).via).toBe('proxy:fin');
    // рабочий выход xray запоминается на час
    r.route.at -= 30 * 60_000;
    expect((await call()).via).toBe('proxy:fin');
  });
});
