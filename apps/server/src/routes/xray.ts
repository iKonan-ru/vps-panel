import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import type { SecretBox } from '../lib/secret-box.js';
import { type ExitDeps, type XraySpares, prepareExit, realityInbounds } from '../lib/xray-exits.js';
import type { XrayManager } from '../lib/xray.js';
import { xuiApi } from '../lib/xui-api.js';
import { xuiToken } from '../lib/xui-token.js';

/**
 * Выход панели в Telegram через xray: основной выход - сервер с 3x-ui и Reality-инбаунд по
 * выбору владельца, запасные панель готовит сама (lib/xray-exits.ts); клиент vps-panel
 * заводится через API 3x-ui, конфиг собирается и применяется панелью.
 */
export async function xrayRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    registry: AgentRegistry;
    box: SecretBox;
    xray: XrayManager;
    spares: XraySpares;
    deps: ExitDeps;
  },
) {
  const { db, registry, box, xray, spares, deps } = opts;

  app.get('/api/xray', async () => xray.status());

  app.get('/api/xray/inbounds', async (req, reply) => {
    const { server } = z.object({ server: z.string() }).parse(req.query);
    if (!registry.isOnline(server)) return reply.code(409).send({ error: 'Агент не подключён' });
    const api = xuiApi(registry, server, await xuiToken(db, box, registry, server));
    const list = await realityInbounds(api);
    return {
      inbounds: list
        .filter((i) => !i.nodeId)
        .map(({ id, remark, port, enable, tcp }) => ({ id, remark, port, enable, tcp })),
    };
  });

  app.post('/api/xray/setup', async (req) => {
    const body = z.object({ serverId: z.string(), inboundId: z.number().int() }).parse(req.body);
    const ob = await prepareExit(deps, body.serverId, body.inboundId);
    await xray.save(ob);
    await xray.start();
    await new Promise((r) => setTimeout(r, 1_500));
    const check = await xray.check();
    app.log.info(
      { server: ob.serverName, inbound: ob.inboundRemark, ok: check.ok },
      'xray: настроен',
    );
    // запасные - в фоне: основной сервер мог быть среди них
    void spares.sync().catch((e: Error) => app.log.warn({ err: e.message }, 'xray: запасные'));
    return { status: xray.status(), check };
  });

  app.post('/api/xray/check', async () => ({ check: await xray.check(), status: xray.status() }));

  /** Подготовить запасные выходы сейчас (кнопка в настройках). */
  app.post('/api/xray/spares', async () => {
    await spares.sync();
    return { status: xray.status() };
  });

  /**
   * Выключить выход: процесс останавливается, настройки и запасные стираются; клиенты
   * vps-panel в 3x-ui остаются.
   */
  app.post('/api/xray/disable', async () => {
    await xray.save(null);
    await xray.stop();
    return { status: xray.status() };
  });
}
