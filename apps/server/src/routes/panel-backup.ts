import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '../lib/auth.js';
import type { PanelBackups } from '../lib/panel-backup.js';
import { type StepUp, hasStepUp } from '../lib/step-up.js';
import { sessionToken } from './auth.js';

/** Бэкап самой панели: настройки, отправка в Telegram, скачивание. */
export async function panelBackupRoutes(
  app: FastifyInstance,
  opts: { backups: PanelBackups; stepUp: StepUp; secure: boolean },
) {
  const { backups, stepUp, secure } = opts;
  const guard = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const sid = sessionToken(req);
    if (!sid || !hasStepUp(stepUp, req, secure, sha256(sid)))
      return reply
        .code(403)
        .send({ error: 'нужно подтверждение пароля и 2FA', code: 'step_up_required' });
    return null;
  };

  app.get('/api/panel-backup', async () => backups.status());

  app.post('/api/panel-backup/settings', async (req, reply) => {
    if (guard(req, reply)) return;
    const body = z
      .object({
        password: z
          .string()
          .min(12, 'пароль\u00a0\u2014 не короче 12\u00a0символов')
          .max(200)
          .optional(),
        telegram: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (body.password !== undefined) backups.setPassword(body.password);
    if (body.telegram !== undefined) backups.setTelegram(body.telegram);
    return backups.status();
  });

  app.post('/api/panel-backup/telegram', async (req, reply) => {
    if (guard(req, reply)) return;
    return backups.sendToTelegram();
  });

  /** Зашифрованный архив файлом: собирается заново при каждом скачивании. */
  app.get('/api/panel-backup/download', async (req, reply) => {
    if (guard(req, reply)) return;
    const b = await backups.build('download');
    backups.finish(b.startedAt, 'download', true, b.data.length);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${b.name}"`)
      .header('Cache-Control', 'no-store')
      .send(b.data);
  });
}
