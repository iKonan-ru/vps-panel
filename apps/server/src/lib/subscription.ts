import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gclientBindings, gclients, servers } from '../db/schema.js';
import { awgTunnelNames } from './awg-config.js';
import { parseNaiveLink } from './gclient-services.js';

/**
 * Ссылка из 3X-UI (subLinks) для клиента: адрес localhost/127.0.0.1 (3X-UI так подставляет без
 * домена) - на адрес сервера; подпись - "(флаг) Страна :: Хостинг", при нескольких inbound-ах
 * на сервере - плюс имя inbound-а (3X-UI подписывает "<inbound>-<email>").
 */
export function rewriteLink(
  link: string,
  o: { host: string; title: string; email: string; withInbound: boolean },
): string {
  const hash = link.indexOf('#');
  let base = hash >= 0 ? link.slice(0, hash) : link;
  let original = '';
  try {
    original = hash >= 0 ? decodeURIComponent(link.slice(hash + 1)) : '';
  } catch {
    original = link.slice(hash + 1);
  }
  const host = o.host.includes(':') ? `[${o.host}]` : o.host;
  base = base.replace(/@(localhost|127\.0\.0\.1|\[::1\]):/, `@${host}:`);
  const inbound = original.endsWith(`-${o.email}`)
    ? original.slice(0, -(o.email.length + 1))
    : original;
  const remark = o.withInbound && inbound ? `${o.title} :: ${inbound}` : o.title;
  // пробел - %20, а не "+": v2rayNG иначе покажет плюсы
  return `${base}#${encodeURIComponent(remark)}`;
}

/**
 * Подписка клиента по токену: ссылки VLESS со всех серверов из кэша привязок (обновляет сверка),
 * без запросов к агентам. Нет клиента - null; выключен - пустой список.
 */
export function buildSubscription(db: Db, token: string): { links: string[] } | null {
  const c = db
    .select()
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
  if (!c) return null;
  if (!c.enabled) return { links: [] };
  const rows = db
    .select({ b: gclientBindings, s: servers })
    .from(gclientBindings)
    .innerJoin(servers, eq(servers.id, gclientBindings.serverId))
    // сервер выключен из глобальных клиентов (перед удалением) - его ссылок в подписке нет,
    // даже пока он офлайн и сверка не убрала привязки
    .where(
      and(
        eq(gclientBindings.clientId, c.id),
        eq(gclientBindings.service, 'xui'),
        eq(servers.gclients, true),
      ),
    )
    .all()
    .sort((x, y) => x.s.name.localeCompare(y.s.name));
  const links: string[] = [];
  for (const { b, s } of rows) {
    const { title } = awgTunnelNames({
      provider: s.provider,
      country: s.country,
      serverName: s.name,
    });
    for (const l of b.links)
      links.push(
        rewriteLink(l, { host: s.host, title, email: b.ref, withInbound: b.links.length > 1 }),
      );
  }
  return { links };
}

/** Профиль qWDTT из ссылки qwdtt://config?... - её собирает сверка. */
export function wdttProfile(link: string) {
  const q = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  return {
    name: q.get('name') ?? '',
    peer: q.get('peer') ?? '',
    hashes: q.get('hashes') ?? '',
    workers: Number(q.get('workers') ?? 9),
    port: Number(q.get('port') ?? 9000),
    password: q.get('pass') ?? '',
  };
}

/**
 * Подписка qWDTT: профиль на каждый сервер с WDTT из кэша привязок.
 * Без хешей приложение берёт свои ("общие хеши" клиента). Нет клиента - null; выключен - пусто.
 */
export function buildWdttSubscription(
  db: Db,
  token: string,
): { profiles: ReturnType<typeof wdttProfile>[] } | null {
  const c = db
    .select()
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
  if (!c) return null;
  if (!c.enabled) return { profiles: [] };
  const rows = db
    .select({ b: gclientBindings, s: servers })
    .from(gclientBindings)
    .innerJoin(servers, eq(servers.id, gclientBindings.serverId))
    .where(
      and(
        eq(gclientBindings.clientId, c.id),
        eq(gclientBindings.service, 'wdtt'),
        eq(servers.gclients, true),
      ),
    )
    .all()
    .sort((x, y) => x.s.name.localeCompare(y.s.name));
  return {
    profiles: rows.flatMap(({ b }) => (b.links[0] ? [wdttProfile(b.links[0])] : [])),
  };
}

/** Сервер в подписке расширения Chrome. */
export interface BrowserServer {
  id: string;
  title: string;
  host: string;
  /** порты прокси по порядку: 443 (если прокси отвечает и там), затем свой порт */
  ports: number[];
  user: string;
  pass: string;
  /** секретное имя: запрос к нему через прокси даёт 407 - так расширение подставляет пароль */
  probe: string;
}

/**
 * Подписка расширения Chrome: прокси для браузера на каждом сервере из кэша привязок (ссылки
 * naive+https собирает сверка). Нет клиента - null; выключен - suspended и пустой список.
 */
export function buildBrowserSubscription(
  db: Db,
  token: string,
): { name: string; suspended: boolean; servers: BrowserServer[] } | null {
  const c = db
    .select()
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
  if (!c) return null;
  if (!c.enabled) return { name: c.name, suspended: true, servers: [] };
  const rows = db
    .select({ b: gclientBindings, s: servers })
    .from(gclientBindings)
    .innerJoin(servers, eq(servers.id, gclientBindings.serverId))
    .where(
      and(
        eq(gclientBindings.clientId, c.id),
        eq(gclientBindings.service, 'naive'),
        eq(gclientBindings.state, 'ok'),
        eq(servers.gclients, true),
      ),
    )
    .all()
    .sort((x, y) => x.s.name.localeCompare(y.s.name));
  const list: BrowserServer[] = [];
  for (const { b, s } of rows) {
    const p = b.links[0] ? parseNaiveLink(b.links[0]) : null;
    if (!p) continue;
    list.push({
      id: s.id,
      title: p.title,
      host: p.host,
      ports: p.ports,
      user: p.user,
      pass: p.password,
      probe: p.probe,
    });
  }
  return { name: c.name, suspended: false, servers: list };
}
