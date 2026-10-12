import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PanelBackups } from '../lib/panel-backup.js';

/** Бэкап самой панели: настройки, отправка в Telegram, скачивание. */
export async function panelBackupRoutes(app: FastifyInstance, opts: { backups: PanelBackups }) {
  const { backups } = opts;

  app.get('/api/panel-backup', async () => backups.status());

  app.post('/api/panel-backup/settings', async (req) => {
    const body = z
      .object({
        password: z
          .string()
          .min(8, 'пароль\u00a0\u2014 не короче 8\u00a0символов')
          .max(200)
          .optional(),
        telegram: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (body.password !== undefined) backups.setPassword(body.password);
    if (body.telegram !== undefined) backups.setTelegram(body.telegram);
    return backups.status();
  });

  app.post('/api/panel-backup/telegram', async () => backups.sendToTelegram());

  /** Зашифрованный архив файлом: собирается заново при каждом скачивании. */
  app.get('/api/panel-backup/download', async (_req, reply) => {
    const b = await backups.build('download');
    backups.finish(b.startedAt, 'download', true, b.data.length);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${b.name}"`)
      .header('Cache-Control', 'no-store')
      .send(b.data);
  });
}
