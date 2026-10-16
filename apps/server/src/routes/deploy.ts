import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PANEL_COMMIT, PANEL_VERSION } from '../lib/version.js';

/** Когда запущен этот процесс панели: браузер по смене значения понимает, что панель обновилась. */
const bootedAt = new Date().toISOString();

/**
 * Ход выкладки панели: сборка на сервере пишет data/deploy.json (этап, шаг, итог).
 * Пока идёт сборка, отвечает прежняя версия панели - она и показывает полосу с ходом.
 */
export async function deployRoutes(app: FastifyInstance, opts: { dataDir: string }) {
  app.get('/api/deploy', async () => {
    let status: unknown = null;
    try {
      status = JSON.parse(await readFile(join(opts.dataDir, 'deploy.json'), 'utf8'));
    } catch {}
    return { status, bootedAt, version: PANEL_VERSION, commit: PANEL_COMMIT };
  });
}
