import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { cascades, gclientBindings, gclients, servers } from '../db/schema.js';
import { awgTunnelNames } from './awg-config.js';
import { clientHost } from './client-host.js';
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

/** Порт из ссылки vless://...@адрес:порт; нет - 0. */
export function linkPort(link: string): number {
  return Number(/@(?:\[[^\]]*\]|[^:/?#@]+):(\d+)/.exec(link)?.[1] ?? 0);
}

/**
 * Подписка клиента по токену: ссылки VLESS со всех серверов из кэша привязок (обновляет сверка),
 * без запросов к агентам. Нет клиента - null; выключен - пустой список.
 */
export function buildSubscription(db: Db, token: string): { name: string; links: string[] } | null {
  const c = db
    .select()
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
  if (!c) return null;
  if (!c.enabled) return { name: c.name, links: [] };
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
    .all();
  const byId = new Map(
    db
      .select()
      .from(servers)
      .all()
      .map((s) => [s.id, s]),
  );
  // каскады: порт inbound-а входа -> выход (ссылка через вход подписывается по выходу)
  const via = new Map<string, Map<number, string>>();
  // выход -> входы его каскадов: у выхода с несколькими входами в подписи - имя входа
  const entriesOf = new Map<string, Set<string>>();
  for (const r of db.select().from(cascades).all()) {
    // каскад с ошибкой не ведёт через выход: такую ссылку "через РФ" не подписываем
    if (!r.entryPort || r.error) continue;
    const m = via.get(r.entryServerId) ?? new Map<number, string>();
    m.set(r.entryPort, r.exitServerId);
    via.set(r.entryServerId, m);
    entriesOf.set(
      r.exitServerId,
      (entriesOf.get(r.exitServerId) ?? new Set()).add(r.entryServerId),
    );
  }
  const items: { name: string; rank: number; link: string }[] = [];
  for (const { b, s } of rows) {
    const { title } = awgTunnelNames({
      provider: s.provider,
      country: s.country,
      serverName: s.name,
    });
    for (const l of b.links) {
      const exit = byId.get(via.get(s.id)?.get(linkPort(l)) ?? '');
      if (exit) {
        // каскадная ссылка - сразу после прямых ссылок своего выхода
        const exitTitle = awgTunnelNames({
          provider: exit.provider,
          country: exit.country,
          serverName: exit.name,
        }).title;
        // один вход - "через РФ"; несколько - различимо: "через РФ (Вход)"
        const several = (entriesOf.get(exit.id)?.size ?? 0) > 1;
        const through = s.country !== 'RU' ? s.name : several ? `РФ (${s.name})` : 'РФ';
        items.push({
          name: exit.name,
          rank: 1,
          link: rewriteLink(l, {
            host: clientHost(s),
            title: `${exitTitle} через ${through}`,
            email: b.ref,
            withInbound: false,
          }),
        });
        continue;
      }
      items.push({
        name: s.name,
        rank: 0,
        link: rewriteLink(l, {
          host: clientHost(s),
          title,
          email: b.ref,
          withInbound: b.links.filter((x) => !via.get(s.id)?.has(linkPort(x))).length > 1,
        }),
      });
    }
  }
  items.sort((x, y) => x.name.localeCompare(y.name) || x.rank - y.rank);
  const links = items.map((i) => i.link);
  return { name: c.name, links };
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
): { name: string; profiles: ReturnType<typeof wdttProfile>[] } | null {
  const c = db
    .select()
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
  if (!c) return null;
  if (!c.enabled) return { name: c.name, profiles: [] };
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
    name: c.name,
    profiles: rows.flatMap(({ b }) => (b.links[0] ? [wdttProfile(b.links[0])] : [])),
  };
}

/** Сервер в подписке расширения Chrome. */
interface BrowserServer {
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
