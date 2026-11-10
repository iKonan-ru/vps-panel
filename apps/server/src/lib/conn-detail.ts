import type {
  ConnAddrView,
  ConnAwgView,
  ConnKind,
  ConnUser,
  ConnsListSnapshot,
  ConnsView,
  Service,
} from '@vps/protocol';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gclientBindings, gclientDevices, gclients, servers } from '../db/schema.js';
import { cascadeClientEmail, isCascadeClient } from './cascades.js';
import { awgRef } from './gclient-services.js';

/** Название порта: сервис и подпись inbound-а из списка портов инвентаря ("8443/tcp XHTTP"). */
export function portLabel(services: Service[], port: number): string {
  for (const sv of services) {
    const hit = sv.ports.find((p) => p.startsWith(`${port}/`));
    if (hit) return [sv.title, ...hit.split(' ').slice(1)].join(' ');
  }
  return '';
}

const NOTES: Record<ConnKind, (name: string | null, conns: number) => string> = {
  cascade: (name) =>
    `Вход каскада${name ? ` ${name}` : ''}: через этот адрес идёт трафик всех его клиентов, поэтому соединений много`,
  server: (name) => `Сервер ${name ?? ''} из панели`.trim(),
  client: (_, conns) =>
    conns > 1
      ? 'Устройство клиента: каждое приложение и сайт открывают отдельные соединения'
      : 'Устройство клиента',
  unknown: () =>
    'Не опознан: адрес не принадлежит ни клиенту xray, ни серверу панели. Это может быть клиент MTProxy или WDTT, неактивный клиент, сканер или бот',
};

/**
 * Подробные подключения сервера для вкладки: адреса со снимка агента получают подписи панели
 * (клиент, вход каскада, сервер), порты - названия сервисов. Подписи агента не берутся.
 */
export function buildConns(
  db: Db,
  serverId: string,
  snap: ConnsListSnapshot,
  ctx: { services: Service[]; panelIps: string[]; clients: number | null },
): ConnsView {
  const clientByRef = new Map(
    db
      .select({ ref: gclientBindings.ref, name: gclients.name })
      .from(gclientBindings)
      .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
      .where(and(eq(gclientBindings.serverId, serverId), eq(gclientBindings.service, 'xui')))
      .all()
      .map((r) => [r.ref, r.name]),
  );
  const all = db
    .select({ id: servers.id, name: servers.name, host: servers.host })
    .from(servers)
    .all();
  const entryByEmail = new Map(all.map((s) => [cascadeClientEmail(s.id), s.name]));
  const serverByHost = new Map(all.map((s) => [s.host, s.name]));
  const panel = new Set(ctx.panelIps);

  const userOf = (email: string): ConnUser => {
    if (isCascadeClient(email))
      return { name: entryByEmail.get(email) ?? 'удалённый вход', kind: 'cascade' };
    const name = clientByRef.get(email);
    return name !== undefined ? { name, kind: 'client' } : { name: email, kind: 'other' };
  };

  const addrs: ConnAddrView[] = snap.addrs.map((a) => {
    const users = a.users.map(userOf);
    const cascade = users.find((u) => u.kind === 'cascade');
    const clientNames = users.filter((u) => u.kind !== 'cascade').map((u) => u.name);
    let kind: ConnKind = 'unknown';
    let name: string | null = null;
    if (cascade) {
      kind = 'cascade';
      name = cascade.name;
    } else if (panel.has(a.ip)) {
      kind = 'server';
      name = 'сервер панели';
    } else if (serverByHost.has(a.ip)) {
      kind = 'server';
      name = serverByHost.get(a.ip) ?? null;
    } else if (clientNames.length > 0) {
      kind = 'client';
      name = clientNames.join(', ');
    }
    return {
      ip: a.ip,
      kind,
      name,
      users,
      note: NOTES[kind](name, a.conns),
      conns: a.conns,
      ports: a.ports.map((p) => ({
        port: p.port,
        label: portLabel(ctx.services, p.port),
        conns: p.conns,
      })),
    };
  });

  const awgBindings = db
    .select({
      ref: gclientBindings.ref,
      client: gclients.name,
      device: gclientDevices.name,
    })
    .from(gclientBindings)
    .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
    .leftJoin(gclientDevices, eq(gclientDevices.id, gclientBindings.deviceId))
    .where(and(eq(gclientBindings.serverId, serverId), eq(gclientBindings.service, 'awg')))
    .all();
  const awgByKey = new Map(
    awgBindings.map((b) => [`${awgRef(b.ref).container}|${awgRef(b.ref).publicKey}`, b]),
  );
  const awg: ConnAwgView[] = snap.awg.map((p) => {
    const b = awgByKey.get(`${p.container}|${p.key}`);
    return {
      ip: p.ip,
      name: b ? [b.client, b.device].filter(Boolean).join(', ') : 'неизвестный пир',
      kind: b ? 'client' : 'unknown',
      handshakeAt: new Date(p.handshake * 1000).toISOString(),
      rx: p.rx,
      tx: p.tx,
    };
  });

  return {
    at: new Date(snap.at).toISOString(),
    clients: ctx.clients,
    conns: addrs.reduce((n, a) => n + a.conns, 0),
    addresses: addrs.length,
    truncated: snap.truncated,
    ports: snap.listeners.map((l) => ({
      port: l.port,
      process: l.process,
      label: portLabel(ctx.services, l.port),
      conns: l.conns,
      ips: l.ips,
    })),
    addrs,
    awg,
    errors: snap.errors ?? {},
  };
}
