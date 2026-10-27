import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PANEL_COMMIT, PANEL_VERSION } from '../lib/version.js';

/** Когда запущен этот процесс панели: браузер по смене значения понимает, что панель обновилась. */
const bootedAt = new Date().toISOString();

/** Шаг без вестей от службы обновления дольше этого - обновление оборвалось. */
export const DEPLOY_STALE_SEC = 30 * 60;

const RELEASE = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

interface DeployFile {
  state?: unknown;
  commit?: unknown;
  step?: unknown;
  total?: unknown;
  updatedAt?: unknown;
  tail?: unknown;
  [k: string]: unknown;
}

/**
 * Ход обновления для полосы. Служба на хосте пишет итог сама, но её могли прервать (перезагрузка,
 * остановка, нехватка места) - тогда в файле навсегда осталось бы "выполняется". Поэтому: целевая
 * версия уже отвечает после перезапуска (шаг 3 и дальше) - обновление удалось; шаг молчит дольше
 * DEPLOY_STALE_SEC - не удалось, работает эта версия.
 */
export function deployStatus(raw: unknown, version: string, nowSec: number): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as DeployFile;
  if (d.state === 'done') return d;
  const total = Number(d.total) || 4;
  if (RELEASE.test(version) && d.commit === version && Number(d.step) >= 3)
    return { ...d, state: 'done', step: total, stepName: 'готово', running: version };
  if (d.state === 'building' && nowSec - Number(d.updatedAt ?? 0) > DEPLOY_STALE_SEC) {
    const tail = Array.isArray(d.tail) ? d.tail : [];
    return {
      ...d,
      state: 'failed',
      running: version,
      tail: [...tail, 'служба обновления не сообщила итог: обновление прервано'],
    };
  }
  return d;
}

/**
 * Ход выкладки панели: служба обновления на хосте пишет data/deploy.json (этап, шаг, итог).
 * Пока она работает, отвечает прежняя версия панели - она и показывает полосу с ходом.
 */
export async function deployRoutes(app: FastifyInstance, opts: { dataDir: string }) {
  app.get('/api/deploy', async () => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(join(opts.dataDir, 'deploy.json'), 'utf8'));
    } catch {}
    const status = deployStatus(raw, PANEL_VERSION, Math.floor(Date.now() / 1000));
    return { status, bootedAt, version: PANEL_VERSION, commit: PANEL_COMMIT };
  });
}
