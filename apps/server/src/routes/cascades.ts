import { CASCADE_MODES, type CascadeMode } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Cascades } from '../lib/cascades.js';
import { FINGERPRINTS, MAX_SERVER_NAMES, realityNames } from '../lib/xui-new-inbound.js';

const Id = z.object({ id: z.string() });
const Cid = z.object({ cid: z.string() });
const Mode = z.enum(CASCADE_MODES as [CascadeMode, ...CascadeMode[]]);
const List = z.array(z.string().max(200)).max(300);
const Host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'неверное имя');
const Target = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3}):\d{1,5}$/, 'цель - имя:порт');

const AddBody = z.object({
  exitServerId: z.string().min(1),
  exitInboundId: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  target: Target,
  serverNames: z.array(Host).min(1).max(MAX_SERVER_NAMES),
  fingerprint: z.enum(FINGERPRINTS),
  mode: Mode,
  directList: List.default([]),
  exitList: List.default([]),
  blockQuic: z.boolean().default(false),
});
const EditBody = z.object({
  exitInboundId: z.number().int().positive().optional(),
  mode: Mode.optional(),
  directList: List.optional(),
  exitList: List.optional(),
  blockQuic: z.boolean().optional(),
  target: Target.optional(),
  serverNames: z.array(Host).min(1).max(MAX_SERVER_NAMES).optional(),
  fingerprint: z.enum(FINGERPRINTS).optional(),
});

const clean = (l: string[]) => l.map((s) => s.trim()).filter(Boolean);

/** Каскады VLESS: блок во вкладке 3X-UI входа (и строка "через этот сервер" на выходе). */
export async function cascadeRoutes(app: FastifyInstance, opts: { cascades: Cascades }) {
  const { cascades } = opts;

  app.get('/api/servers/:id/cascades', async (req) => cascades.list(Id.parse(req.params).id));

  app.get('/api/servers/:id/cascades/new', async (req) =>
    cascades.newInfo(Id.parse(req.params).id),
  );

  app.post('/api/servers/:id/cascades', async (req) => {
    const { id } = Id.parse(req.params);
    const body = AddBody.parse(req.body ?? {});
    const names = realityNames(body.serverNames);
    if (!names.length)
      throw Object.assign(new Error('нет подходящих имён Reality'), { statusCode: 400 });
    const actionId = await cascades.create(id, {
      ...body,
      serverNames: names,
      directList: clean(body.directList),
      exitList: clean(body.exitList),
    });
    return { actionId };
  });

  app.post('/api/cascades/:cid/edit', async (req) => {
    const { cid } = Cid.parse(req.params);
    const body = EditBody.parse(req.body ?? {});
    const names = body.serverNames ? realityNames(body.serverNames) : undefined;
    if (names && !names.length)
      throw Object.assign(new Error('нет подходящих имён Reality'), { statusCode: 400 });
    const actionId = await cascades.edit(cid, {
      ...body,
      ...(names ? { serverNames: names } : {}),
      ...(body.directList ? { directList: clean(body.directList) } : {}),
      ...(body.exitList ? { exitList: clean(body.exitList) } : {}),
    });
    return { actionId };
  });

  app.post('/api/cascades/:cid/delete', async (req) => {
    await cascades.remove(Cid.parse(req.params).cid);
    return { ok: true };
  });

  app.post('/api/cascades/:cid/check', async (req) => cascades.check(Cid.parse(req.params).cid));
}
