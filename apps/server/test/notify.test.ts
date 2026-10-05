import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { Telegram } from '../src/lib/telegram.js';

describe('Telegram.send', () => {
  it('delivers in order, each call gets its own result, a failure does not drop the rest', async () => {
    const n = new Telegram(createDb(':memory:'), new SecretBox('x'.repeat(32)), {} as never, {
      info: () => undefined,
      warn: () => undefined,
    });
    await n.save({ token: '1:t', chatId: '42' });
    const sent: string[] = [];
    (n as unknown as { deliver: (st: unknown, m: string) => Promise<string | null> }).deliver =
      async (_st, m) => {
        sent.push(m);
        return m === 'b' ? 'Telegram недоступен' : null;
      };
    const res = await Promise.all([n.send('a'), n.send('b'), n.send('c')]);
    expect(res).toEqual([null, 'Telegram недоступен', null]);
    expect(sent).toEqual(['a', 'b', 'c']);
  });
});
