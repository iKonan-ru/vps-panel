import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployStatus } from '../src/routes/deploy.js';

/** Разбор событий загрузки - тот самый фрагмент Python из deploy/release/vps-panel. */
const script = readFileSync(join(__dirname, '../../../deploy/release/vps-panel'), 'utf8');
const parser =
  /read -r -d '' PULL_PROGRESS_PY <<'PY' \|\| true\n([\s\S]*?)\nPY\n/.exec(script)?.[1] ?? '';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pull-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (o: Record<string, unknown>) => JSON.stringify({ parent_id: 'Image panel', ...o });

function run(lines: string[]) {
  const status = join(dir, 'deploy.json');
  const tail = join(dir, 'tail.log');
  writeFileSync(status, JSON.stringify({ state: 'building', step: 2, total: 4, updatedAt: 1 }));
  writeFileSync(tail, '');
  execFileSync('python3', ['-I', '-c', parser, status, tail], { input: `${lines.join('\n')}\n` });
  return {
    d: JSON.parse(readFileSync(status, 'utf8')) as Record<string, unknown>,
    tail: readFileSync(tail, 'utf8'),
  };
}

describe('ход загрузки образов (vps-panel update, шаг 2)', () => {
  it('фрагмент найден в скрипте', () => {
    expect(parser).toContain('Pulling fs layer');
  });

  it('идёт загрузка: слои без уже скачанных и без блобов конфигурации, байты, доля', () => {
    const { d } = run([
      JSON.stringify({ id: 'Image panel', status: 'Working', text: 'Pulling' }),
      ev({ id: 'aaa', text: 'Already exists' }),
      ev({ id: 'big', text: 'Pulling fs layer' }),
      ev({ id: 'small', text: 'Pulling fs layer' }),
      ev({ id: 'cfg', text: 'Downloading', current: 5000, total: 5000 }),
      ev({ id: 'cfg', text: 'Download complete' }),
      ev({ id: 'small', text: 'Downloading', current: 500_000, total: 1_000_000 }),
      ev({ id: 'small', text: 'Download complete' }),
      ev({ id: 'big', text: 'Downloading', current: 45_088_768, total: 57_417_398 }),
    ]);
    expect(d.progress).toBe('слоёв 1 из 2, скачано 46 МБ');
    expect(d.fraction).toBeCloseTo((0.9 * (1 + 45_088_768 / 57_417_398)) / 2, 2);
    expect(Number(d.updatedAt)).toBeGreaterThan(1);
    expect(d.state).toBe('building');
  });

  it('всё скачано - распаковка; не-JSON строки и ошибки - в журнал', () => {
    const { d, tail } = run([
      'какая-то строка compose',
      ev({ id: 'l1', text: 'Pulling fs layer' }),
      ev({ id: 'l1', text: 'Downloading', current: 100, total: 3_000_000 }),
      ev({ id: 'l1', text: 'Download complete' }),
      ev({ id: 'l1', text: 'Extracting', current: 1 }),
      JSON.stringify({ id: 'Image caddy', status: 'Error', text: 'denied' }),
    ]);
    expect(d.progress).toBe('скачано 3.0 МБ, распаковка: слоёв 0 из 1');
    expect(tail).toContain('какая-то строка compose');
    expect(tail).toContain('Image caddy: denied');
  });

  it('progress: пишет текст, долю и время только во время обновления', () => {
    const fn = /\nprogress\(\) \{[\s\S]*?\nPY\n\}\n/.exec(script)?.[0] ?? '';
    expect(fn).toContain('updatedAt');
    const status = join(dir, 'deploy.json');
    writeFileSync(status, JSON.stringify({ state: 'building', step: 1, updatedAt: 1 }));
    const sh = (started: string, args: string) =>
      execFileSync('bash', [
        '-c',
        `${fn}\nSTARTED=${started} STATUS='${status}'\nprogress ${args}`,
      ]);
    sh('0', "'вне обновления' 0.5");
    expect(JSON.parse(readFileSync(status, 'utf8')).progress).toBeUndefined();
    sh('1', "'файл 2 из 6: vps-panel' 0.17");
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({
      progress: 'файл 2 из 6: vps-panel',
      fraction: 0.17,
      state: 'building',
    });
    sh('1', "'без доли'");
    expect(JSON.parse(readFileSync(status, 'utf8')).fraction).toBeUndefined();
  });

  it('ход проходит через /api/deploy как есть', () => {
    const raw = {
      state: 'building',
      commit: '1.31.0',
      step: 2,
      total: 4,
      updatedAt: 100,
      progress: 'слоёв 1 из 2',
      fraction: 0.4,
    };
    expect(deployStatus(raw, '1.30.0', 200)).toMatchObject({
      progress: 'слоёв 1 из 2',
      fraction: 0.4,
    });
  });
});
