import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import type { SecretBox } from '../lib/secret-box.js';
import type { XrayManager, XrayOutbound } from '../lib/xray.js';
import {
  type XuiEnvelope,
  xuiApi as callXui,
  parseJson,
  readClient,
  unwrap,
} from '../lib/xui-api.js';
import { xuiToken as issueXuiToken } from '../lib/xui-token.js';

const CLIENT_EMAIL = 'vps-panel';

/**
 * Выход панели в Telegram через xray: выбор сервера с 3x-ui и Reality-инбаунда, клиент
 * vps-panel заводится через API 3x-ui, конфиг собирается и применяется панелью.
 */
export async function xrayRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; box: SecretBox; xray: XrayManager },
) {
  const { db, registry, box, xray } = opts;

  const xuiToken = (serverId: string) => issueXuiToken(db, box, registry, serverId);

  const xuiApi = (serverId: string, token: string) => callXui(registry, serverId, token);

  /** Reality-инбаунды VLESS сервера: для выбора в настройках. */
  async function realityInbounds(serverId: string, token: string) {
    const api = xuiApi(serverId, token);
    const list =
      (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<string, unknown>[]) ??
      [];
    return list
      .filter((i) => {
        const ss = parseJson(i.streamSettings);
        return i.protocol === 'vless' && ss.security === 'reality';
      })
      .map((i) => ({
        id: Number(i.id),
        remark: String(i.remark ?? ''),
        port: Number(i.port),
        enable: Boolean(i.enable),
      }));
  }

  app.get('/api/xray', async () => xray.status());

  app.get('/api/xray/inbounds', async (req, reply) => {
    const { server } = z.object({ server: z.string() }).parse(req.query);
    if (!registry.isOnline(server)) return reply.code(409).send({ error: 'Агент не подключён' });
    const token = await xuiToken(server);
    return { inbounds: await realityInbounds(server, token) };
  });

  app.post('/api/xray/setup', async (req, reply) => {
    const body = z.object({ serverId: z.string(), inboundId: z.number().int() }).parse(req.body);
    const row = (await db.select().from(servers).where(eq(servers.id, body.serverId)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });
    if (!registry.isOnline(row.id)) return reply.code(409).send({ error: 'Агент не подключён' });
    const inv = (row.statusCache as StatusCache | null)?.inventory;
    if (!inv?.services.some((s) => s.kind === 'xui')) {
      return reply.code(409).send({ error: 'На этом сервере агент не нашёл 3X-UI' });
    }
    const token = await xuiToken(row.id);
    const api = xuiApi(row.id, token);

    const inbound = unwrap(
      await api('GET', `inbounds/get/${body.inboundId}`),
      'inbounds/get',
    ) as Record<string, unknown> | null;
    if (!inbound) return reply.code(502).send({ error: '3X-UI не отдал inbound' });
    const ss = parseJson(inbound.streamSettings);
    const rs = parseJson(ss.realitySettings);
    const rsSettings = parseJson(rs.settings);
    if (inbound.protocol !== 'vless' || ss.security !== 'reality') {
      return reply.code(409).send({ error: 'Нужен inbound VLESS с security = reality' });
    }
    const publicKey = String(rsSettings.publicKey ?? '');
    const shortId = String((rs.shortIds as string[] | undefined)?.[0] ?? '');
    const sni = String((rs.serverNames as string[] | undefined)?.[0] ?? '');
    if (!publicKey || !sni) {
      return reply
        .code(409)
        .send({ error: 'У inbound-а нет publicKey или serverNames в настройках Reality' });
    }

    // клиент vps-panel (3X-UI 3.1+: клиенты - отдельные сущности, как у глобальных клиентов)
    const got = await api('GET', `clients/get/${CLIENT_EMAIL}`);
    if (got.status === 404)
      return reply.code(409).send({ error: '3X-UI старше 3.1 (нет API клиентов): обнови 3X-UI' });
    let client = (got.data as XuiEnvelope | undefined)?.success
      ? readClient((got.data as XuiEnvelope).obj)
      : null;
    if (!client) {
      unwrap(
        await api('POST', 'clients/add', {
          client: {
            email: CLIENT_EMAIL,
            enable: true,
            limitIp: 0,
            totalGB: 0,
            expiryTime: 0,
            subId: randomUUID().replace(/-/g, '').slice(0, 16),
            reset: 0,
            flow: '',
            comment: 'выход VPS Panel в Telegram',
          },
          inboundIds: [body.inboundId],
        }),
        'clients/add',
      );
      client = readClient(unwrap(await api('GET', `clients/get/${CLIENT_EMAIL}`), 'clients/get'));
    } else if (!client.inboundIds.includes(body.inboundId)) {
      unwrap(
        await api('POST', `clients/${CLIENT_EMAIL}/attach`, { inboundIds: [body.inboundId] }),
        'attach',
      );
    }
    const uuid = client?.uuid ?? '';
    if (!uuid) return reply.code(502).send({ error: '3X-UI не вернул uuid клиента vps-panel' });

    const ob: XrayOutbound = {
      serverId: row.id,
      serverName: row.name,
      inboundId: body.inboundId,
      inboundRemark: String(inbound.remark ?? ''),
      address: row.host,
      port: Number(inbound.port),
      uuid,
      publicKey,
      shortId,
      sni,
      fingerprint: String(rsSettings.fingerprint || 'chrome'),
      flow: '',
      updatedAt: new Date().toISOString(),
    };
    await xray.save(ob);
    await xray.start();
    await new Promise((r) => setTimeout(r, 1_500));
    const check = await xray.check();
    app.log.info({ server: row.name, inbound: ob.inboundRemark, ok: check.ok }, 'xray: настроен');
    return { status: xray.status(), check };
  });

  app.post('/api/xray/check', async () => ({ check: await xray.check(), status: xray.status() }));

  /** Выключить выход: процесс останавливается, настройки стираются; клиент в 3x-ui остаётся. */
  app.post('/api/xray/disable', async () => {
    await xray.save(null);
    await xray.stop();
    return { status: xray.status() };
  });
}
