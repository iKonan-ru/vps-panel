import { Socket } from 'node:net';
import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import type { actionJournal } from '../lib/action-journal.js';
import { resolvePublic } from '../lib/client-host.js';
import { type GClients, queued } from '../lib/gclients.js';
import type { RuReach } from '../lib/ru-reach.js';
import type { UiHub } from '../lib/ui-hub.js';
import type { XrayManager } from '../lib/xray.js';

const Id = z.object({ id: z.string() });
const Body = z.object({ ip: z.string().trim().max(45) });

export interface IpStep {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** Адрес агента без префикса IPv4-mapped ("::ffff:1.2.3.4"). */
const plain = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '');

function tcp(host: string, port: number, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (err: string | null) => {
      s.destroy();
      resolve(err);
    };
    s.setTimeout(ms, () => done('нет ответа'));
    s.once('error', (e) => done(e.message));
    s.connect(port, host, () => done(null));
  });
}

/**
 * Смена IP сервера (`15-ip-change.md` в закрытой справке): проверка нового адреса - имя для
 * клиентов (и имя прокси для браузера) уже указывают на него у публичных DNS, агент подключён с
 * него или до SSH есть TCP - и переключение: host, сверка привязок сервера, выходы xray в
 * Telegram, перепроверка доступности из России, запись в журнал.
 */
export async function ipChangeRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    registry: AgentRegistry;
    hub: UiHub;
    gc: GClients;
    xray: XrayManager;
    reach: RuReach;
    journal: ReturnType<typeof actionJournal>;
  },
) {
  const { db, registry, hub, gc, xray, reach, journal } = opts;

  async function check(id: string, ip: string) {
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('Сервер не найден'), { statusCode: 404 });
    const steps: IpStep[] = [];
    if (!isIP(ip)) {
      steps.push({ name: 'Новый адрес', level: 'fail', detail: 'нужен IPv4 или IPv6 адрес' });
      return { row, steps, canSwitch: false };
    }
    if (ip === row.host) {
      steps.push({ name: 'Новый адрес', level: 'fail', detail: 'это текущий адрес сервера' });
      return { row, steps, canSwitch: false };
    }
    steps.push({ name: 'Новый адрес', level: 'ok', detail: `${row.host} -> ${ip}` });

    // имена, которые люди и браузеры знают: адрес для клиентов и имя прокси для браузера
    let dnsOk = true;
    const naive = (row.statusCache as StatusCache | null)?.inventory?.services.find(
      (s) => s.kind === 'naive',
    )?.details?.domain;
    const names = [
      ...(row.clientHost ? [{ name: row.clientHost, what: 'адрес для клиентов', must: true }] : []),
      ...(typeof naive === 'string' && naive && naive !== row.clientHost
        ? [{ name: naive, what: 'прокси для браузера', must: false }]
        : []),
    ];
    if (!row.clientHost)
      steps.push({
        name: 'Адрес для клиентов',
        level: 'warn',
        detail:
          'имени нет - у людей в AWG, WDTT, OpenFlux и MTProxy старый IP, после смены они перестанут работать (VLESS-подписка обновится сама). Лучше сначала задать имя в "Обзоре"',
      });
    for (const n of names) {
      const r = await resolvePublic(n.name);
      const ok = r.addresses.includes(ip);
      if (!ok && n.must) dnsOk = false;
      steps.push({
        name: `DNS: ${n.name}`,
        level: ok ? 'ok' : n.must ? 'fail' : 'warn',
        detail: ok
          ? `${n.what}: указывает на ${ip}`
          : `${n.what}: ${r.error ?? `указывает на ${r.addresses.join(', ')}`} - поправь A-запись на ${ip} и проверь снова (DNS обновляется до нескольких минут)`,
      });
    }

    const conn = registry.get(id);
    const addr = plain(conn?.addr);
    const agentOk = Boolean(conn) && addr === ip;
    steps.push({
      name: 'Агент',
      level: agentOk ? 'ok' : 'warn',
      detail: !conn
        ? 'не на связи'
        : agentOk
          ? `подключён с ${ip}`
          : `подключён с ${addr || 'неизвестного адреса'}: сервер ещё на старом адресе?`,
    });
    const tcpErr = await tcp(ip, row.sshPort, 7000);
    steps.push({
      name: `TCP ${ip}:${row.sshPort}`,
      level: tcpErr ? 'warn' : 'ok',
      detail: tcpErr ? `с панели не открылся: ${tcpErr}` : 'SSH отвечает с панели',
    });
    return { row, steps, canSwitch: dnsOk && (agentOk || !tcpErr) };
  }

  app.post('/api/servers/:id/ip-change/check', async (req) => {
    const { id } = Id.parse(req.params);
    const { ip } = Body.parse(req.body ?? {});
    const { steps, canSwitch } = await check(id, ip);
    return { steps, canSwitch };
  });

  app.post('/api/servers/:id/ip-change', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { ip } = Body.parse(req.body ?? {});
    const { row, steps, canSwitch } = await check(id, ip);
    if (!canSwitch) return reply.code(409).send({ error: 'проверка не пройдена', steps });
    const actionId = await journal.start(id, 'server:ip', { from: row.host, to: ip });
    db.update(servers).set({ host: ip }).where(eq(servers.id, id)).run();
    // ссылки и конфиги на личных страницах - с новым адресом (у кого в них был IP)
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, id)).run();
    gc.kick();
    const xrayMoved = await xray.retarget(id, ip).catch(() => false);
    void reach.check(id).catch(() => undefined);
    hub.broadcast({ type: 'server.changed', serverId: id });
    await journal.finish(
      actionId,
      id,
      0,
      [
        `Адрес сервера: ${row.host} -> ${ip}`,
        ...steps.map((s) => `${s.name}: ${s.detail}`),
        xrayMoved ? 'Выход в Telegram через этот сервер - на новый адрес' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    app.log.info({ serverId: id, from: row.host, to: ip }, 'смена IP сервера');
    return { ok: true, steps };
  });
}
