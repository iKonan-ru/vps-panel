import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AgentRegistry, requireOnline } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { awgTunnelNames } from '../lib/awg-config.js';
import { clientHost } from '../lib/client-host.js';
import { type GClients, queued } from '../lib/gclients.js';
import type { UiHub } from '../lib/ui-hub.js';
import {
  VK_HASH_RE,
  WDTT_PASSWORD_LIMIT,
  type WdttPassword,
  setWdttHashes,
  wdttApi,
  wdttHashes,
  wdttLinks,
} from '../lib/wdtt.js';

const Id = z.object({ id: z.string() });

/**
 * Вкладка WDTT сервера: пароли пользователей - список, создать,
 * изменить, включить/выключить, удалить, отвязать устройство; ссылки для приложений.
 * Изменения - действиями в журнале, пароль туда не пишется.
 */
export async function wdttRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; hub: UiHub; gc: GClients },
) {
  const { db, registry, hub, gc } = opts;
  const journal = actionJournal(db, hub, registry);

  const serverOf = (id: string) => {
    const s = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!s) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    requireOnline(registry, id);
    return s;
  };

  /** Хеши звонков VK: общие для всех клиентов, уходят в ссылки и подписку WDTT. */
  app.get('/api/settings/wdtt', async () => ({ hashes: wdttHashes(db) }));
  app.put('/api/settings/wdtt', async (req) => {
    const { hashes } = z
      .object({
        hashes: z
          .array(z.string().trim().regex(VK_HASH_RE, 'хеш: латиница, цифры, _ и -, 8-128 символов'))
          .max(20),
      })
      .parse(req.body ?? {});
    setWdttHashes(db, [...new Set(hashes)]);
    // ссылки WDTT глобальных клиентов собираются с хешами - пересобрать
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.service, 'wdtt')).run();
    gc.kick();
    return { ok: true };
  });

  app.get('/api/servers/:id/wdtt', async (req, reply) => {
    const s = serverOf(Id.parse(req.params).id);
    const r = await wdttApi(registry, s.id, 'GET', '/admin/passwords');
    const list = ((r.data as { passwords?: WdttPassword[] }).passwords ?? []).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    const hashes = wdttHashes(db);
    const name = awgTunnelNames({
      provider: s.provider,
      country: s.country,
      serverName: s.name,
    }).title;
    reply.header('Cache-Control', 'no-store');
    return {
      limit: WDTT_PASSWORD_LIMIT,
      dtlsPort: r.dtlsPort,
      hashes: hashes.length,
      passwords: list.map((p) => ({
        ...p,
        // у пароля без устройств сервер (Go) отдаёт null, а не пустой список
        device_ids: p.device_ids ?? [],
        links: wdttLinks({
          host: clientHost(s),
          dtlsPort: r.dtlsPort,
          wgPort: r.wgPort,
          password: p.password,
          hashes,
          name,
        }),
      })),
    };
  });

  /** Изменение - действием в журнале (сервер занят - 409); в журнале нет пароля. */
  async function act(
    serverId: string,
    kind: string,
    path: string,
    form: Record<string, string>,
    logParams: Record<string, unknown>,
  ) {
    await journal.quick(serverId, kind, logParams, () =>
      wdttApi(registry, serverId, 'POST', path, form),
    );
  }

  app.post('/api/servers/:id/wdtt/passwords', async (req) => {
    const s = serverOf(Id.parse(req.params).id);
    const b = z
      .object({
        label: z.string().trim().min(1, 'подпись обязательна').max(64),
        maxDevices: z.number().int().min(1).max(50),
        days: z.number().int().min(1).max(365),
      })
      .parse(req.body ?? {});
    // хеш серверу обязателен, но для входа не нужен (только для ссылок бота): нет своих - "-"
    const hash = wdttHashes(db)[0] ?? '-';
    await act(
      s.id,
      'wdtt:password.add',
      '/admin/passwords',
      { label: b.label, max_devices: String(b.maxDevices), days: String(b.days), vk_hash: hash },
      b,
    );
    return { ok: true };
  });

  app.post('/api/servers/:id/wdtt/passwords/:op', async (req, reply) => {
    const p = z
      .object({
        id: z.string(),
        op: z.enum(['activate', 'deactivate', 'delete', 'update', 'unbind-device']),
      })
      .parse(req.params);
    const s = serverOf(p.id);
    const b = z
      .object({
        password: z.string().min(1).max(200),
        /** Подпись: у update - новая, у остальных - только для журнала. */
        label: z.string().trim().max(64).optional(),
        maxDevices: z.number().int().min(1).max(50).optional(),
        days: z.number().int().min(1).max(365).optional(),
        deviceId: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});
    const form: Record<string, string> = { password: b.password };
    if (p.op === 'update') {
      if (b.label) form.label = b.label;
      if (b.maxDevices) form.max_devices = String(b.maxDevices);
      if (b.days) form.days = String(b.days);
    }
    if (p.op === 'unbind-device') {
      if (!b.deviceId) return reply.code(400).send({ error: 'не указано устройство' });
      form.device_id = b.deviceId;
    }
    const { password: _, ...log } = b;
    await act(s.id, `wdtt:password.${p.op}`, `/admin/passwords/${p.op}`, form, log);
    return { ok: true };
  });
}
