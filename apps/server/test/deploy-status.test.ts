import { describe, expect, it } from 'vitest';
import { DEPLOY_STALE_SEC, deployStatus } from '../src/routes/deploy.js';

const NOW = 2_000_000_000;
const file = (over: Record<string, unknown>) => ({
  state: 'building',
  commit: '1.2.0',
  running: '1.1.0',
  startedAt: NOW - 60,
  updatedAt: NOW - 30,
  step: 2,
  total: 4,
  stepName: 'загрузка образов',
  ...over,
});

describe('ход обновления панели', () => {
  it('нет файла или мусор - нет полосы', () => {
    expect(deployStatus(null, '1.1.0', NOW)).toBeNull();
    expect(deployStatus('x', '1.1.0', NOW)).toBeNull();
  });

  it('идущее обновление и итоги - как в файле', () => {
    const f = file({});
    expect(deployStatus(f, '1.1.0', NOW)).toBe(f);
    const done = file({ state: 'done', step: 4, updatedAt: NOW - 10 * DEPLOY_STALE_SEC });
    expect(deployStatus(done, '1.2.0', NOW)).toBe(done);
    const failed = file({ state: 'failed', step: 4 });
    expect(deployStatus(failed, '1.1.0', NOW)).toBe(failed);
  });

  it('целевая версия отвечает после перезапуска - обновление удалось', () => {
    for (const state of ['building', 'failed'])
      expect(
        deployStatus(file({ state, step: 4, updatedAt: NOW - 7000 }), '1.2.0', NOW),
      ).toMatchObject({ state: 'done', step: 4, stepName: 'готово', running: '1.2.0' });
    // до перезапуска (повторная установка той же версии) - ход как есть
    expect(deployStatus(file({ commit: '1.1.0', step: 2 }), '1.1.0', NOW)).toMatchObject({
      state: 'building',
    });
    // сборка из исходников - версии нет
    expect(deployStatus(file({ commit: 'dev', step: 4 }), 'dev', NOW)).toMatchObject({
      state: 'building',
    });
  });

  it('шаг без вестей дольше срока - не удалось, работает эта версия', () => {
    const f = file({ step: 4, updatedAt: NOW - DEPLOY_STALE_SEC - 1, tail: ['docker compose up'] });
    expect(deployStatus(f, '1.1.0', NOW)).toMatchObject({
      state: 'failed',
      step: 4,
      running: '1.1.0',
      tail: ['docker compose up', 'служба обновления не сообщила итог: обновление прервано'],
    });
    expect(deployStatus(file({ updatedAt: NOW - DEPLOY_STALE_SEC }), '1.1.0', NOW)).toMatchObject({
      state: 'building',
    });
  });
});
