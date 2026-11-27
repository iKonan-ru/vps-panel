import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openfluxCmd } from '../src/commands/catalog-openflux.js';

const script = typeof openfluxCmd.script === 'string' ? openfluxCmd.script : '';
const fn = (name: string) =>
  new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(script)?.[0] ?? '';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'of-cat-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** curl-заглушка: N первых POST дают комнату, дальше - отказ (как ограничение частоты). */
function run(rooms: number) {
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/n"\n[ $n -le ${rooms} ] || exit 22\nprintf '{"room":{"id":"r-%s","x":1}}' $n\n`,
  );
  chmodSync(join(dir, 'curl'), 0o755);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n');
  chmodSync(join(dir, 'sleep'), 0o755);
  if (!fn('of_avito_rooms')) throw new Error('функция не найдена');
  const out = execFileSync('bash', ['-c', `${fn('of_avito_rooms')}\nof_avito_rooms`], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return out ? JSON.parse(Buffer.from(out, 'base64url').toString()) : null;
}

describe('установка OpenFlux: комнаты Avito', () => {
  it('16 комнат списком v2', () => {
    const v = run(100);
    expect(v.v).toBe(2);
    expect(v.rooms).toHaveLength(16);
    expect(v.rooms[0]).toBe('r-1');
  });
  it('отказ на середине - чётное число комнат; меньше пары - без Avito', () => {
    expect(run(5).rooms).toEqual(['r-1', 'r-2', 'r-3', 'r-4']);
    expect(run(1)).toBeNull();
  });
  it('автообновление ядра выключено, новые транспорты в конфиге установщика', () => {
    expect(script).toContain("printf 'autoupdate=no\\n'");
    for (const k of ['telemost', 'boards', 'avito']) expect(script).toContain(`'${k}=%s\\n'`);
    expect(openfluxCmd.params.some((p) => p.name === 'OF_AUTOUPDATE')).toBe(false);
  });
});
