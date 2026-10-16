import type { GBrowserExt } from '@vps/protocol';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { gclientExts, gclients, servers } from '../db/schema.js';
import { buildBrowserSubscription } from './subscription.js';

/**
 * Расширение для браузера у клиента: что оно сообщает о себе панели. Отчёт (POST
 * /sub/<токен>/browser/status) - при каждом изменении и раз в 15 минут, пока браузер открыт:
 * версия, браузер, включён ли прокси, выбранный сервер, ошибка в окне. Ни адресов страниц, ни
 * чего-либо о трафике в отчёте нет. О версиях без отчётов известно только, что они брали
 * подписку (строка "legacy-<браузер>" на клиента).
 */

/** На связи: отчёт свежее этого (расширение шлёт раз в 15 минут). */
export const EXT_ONLINE_MS = 20 * 60_000;
/** Установки, не выходившие на связь дольше, забываются (housekeeping). */
export const EXT_FORGET_DAYS = 60;

export const ExtReportSchema = z.object({
  install: z.string().regex(/^[0-9a-f]{16,32}$/),
  version: z.string().regex(/^\d+(\.\d+){0,3}$/),
  browser: z.enum(['chrome', 'firefox', 'other']),
  enabled: z.boolean(),
  server: z.string().max(64),
  error: z.string().max(300).default(''),
});
export type ExtReport = z.infer<typeof ExtReportSchema>;

function clientOf(db: Db, token: string) {
  return db
    .select({ id: gclients.id })
    .from(gclients)
    .where(and(eq(gclients.token, token), isNull(gclients.deletedAt)))
    .get();
}

/** Отчёт расширения; false - токен неизвестен (новая ссылка, клиент удалён). */
export function recordReport(db: Db, token: string, r: ExtReport, now = new Date()): boolean {
  const c = clientOf(db, token);
  if (!c) return false;
  const row = {
    clientId: c.id,
    browser: r.browser,
    version: r.version,
    enabled: r.enabled,
    serverId: r.server || 'auto',
    error: r.error,
    seenAt: now.toISOString(),
  };
  db.insert(gclientExts)
    .values({ id: `${c.id}:${r.install}`, ...row })
    .onConflictDoUpdate({ target: gclientExts.id, set: row })
    .run();
  // обновились с версии без отчётов: её строка больше не нужна
  db.delete(gclientExts)
    .where(eq(gclientExts.id, `${c.id}:legacy-${r.browser}`))
    .run();
  return true;
}

/** Браузер по User-Agent запроса подписки (у Firefox в строке есть и "Firefox", и не "Chrome"). */
export function browserOf(ua: string): ExtReport['browser'] {
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'other';
}

/**
 * Подписку взяла версия без отчётов (с отчётами шлют заголовок x-vps-ext): отметка "была на связи".
 * Если у клиента уже есть отчёты из этого браузера - это они, отметка не нужна.
 */
export function recordLegacyFetch(db: Db, token: string, ua: string, now = new Date()) {
  const c = clientOf(db, token);
  if (!c) return;
  const browser = browserOf(ua);
  const reporting = db
    .select({ id: gclientExts.id })
    .from(gclientExts)
    .where(and(eq(gclientExts.clientId, c.id), eq(gclientExts.browser, browser)))
    .all()
    .some((r) => !r.id.endsWith(`:legacy-${browser}`));
  if (reporting) return;
  const row = { clientId: c.id, browser, seenAt: now.toISOString() };
  db.insert(gclientExts)
    .values({ id: `${c.id}:legacy-${browser}`, ...row })
    .onConflictDoUpdate({ target: gclientExts.id, set: { seenAt: row.seenAt } })
    .run();
}

/** Версия a старее b ("1.4.0" < "1.5.0"). */
function older(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/**
 * Расширения клиентов для интерфейса: клиент -> установки, свежие сверху. latest - версия,
 * которую раздаёт панель (null - неизвестна); online - агент сервера на связи (для "Авто":
 * браузер идёт на первый доступный сервер цепочки).
 */
export function extsByClient(
  db: Db,
  clientIds: string[] | null,
  latest: string | null,
  online: (serverId: string) => boolean = () => true,
  now = Date.now(),
): Map<string, GBrowserExt[]> {
  const rows = db
    .select()
    .from(gclientExts)
    .where(clientIds ? inArray(gclientExts.clientId, clientIds) : undefined)
    .all();
  const names = new Map(
    db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .all()
      .map((s) => [s.id, s.name]),
  );
  // цепочка подписки - только у клиентов с "Авто"
  const chains = new Map<string, string[]>();
  const chainOf = (clientId: string) => {
    let c = chains.get(clientId);
    if (!c) {
      const token = db
        .select({ token: gclients.token })
        .from(gclients)
        .where(eq(gclients.id, clientId))
        .get()?.token;
      c = token ? (buildBrowserSubscription(db, token)?.servers ?? []).map((s) => s.id) : [];
      chains.set(clientId, c);
    }
    return c;
  };
  const out = new Map<string, GBrowserExt[]>();
  for (const r of rows.sort((a, b) => b.seenAt.localeCompare(a.seenAt))) {
    const legacy = r.version === null;
    let via: string | null = r.serverId && r.serverId !== 'auto' ? r.serverId : null;
    if (r.serverId === 'auto') {
      const chain = chainOf(r.clientId);
      via = chain.find(online) ?? chain[0] ?? null;
    }
    const ext: GBrowserExt = {
      id: r.id,
      browser: r.browser as GBrowserExt['browser'],
      version: r.version,
      // Firefox обновляется сам, Chrome - вручную по подсказке в окне расширения
      outdated: legacy || Boolean(latest && r.version && older(r.version, latest)),
      enabled: r.enabled,
      server:
        r.serverId === null
          ? null
          : r.serverId === 'auto'
            ? 'Авто'
            : (names.get(r.serverId) ?? 'сервер удалён'),
      viaServerId: via,
      error: r.error,
      seenAt: r.seenAt,
      online: !legacy && now - Date.parse(r.seenAt) < EXT_ONLINE_MS,
    };
    out.set(r.clientId, [...(out.get(r.clientId) ?? []), ext]);
  }
  return out;
}

/** Забыть установки, которые давно не выходили на связь. */
export function pruneExts(db: Db, now = Date.now()) {
  const before = new Date(now - EXT_FORGET_DAYS * 86_400_000).toISOString();
  db.delete(gclientExts).where(lt(gclientExts.seenAt, before)).run();
}

/** Браузер клиента идёт через этот сервер сейчас: какое расширение и выбран ли сервер сам. */
export interface ExtOnServer {
  browser: GBrowserExt['browser'];
  version: string;
  auto: boolean;
  seenAt: string;
}

/**
 * Через какие серверы идёт браузер клиента сейчас (для точки "на связи" у прокси для браузера в
 * живой статистике: подключений naive сервер не показывает). Берутся установки на связи с
 * включённым прокси; выбран сервер - он, "Авто" - первый в цепочке подписки (тот же порядок, что
 * у расширения), на котором прокси работает (usable): браузер идёт на первый доступный.
 */
export function extServers(
  db: Db,
  clientId: string,
  token: string,
  usable: (serverId: string) => boolean,
  now = Date.now(),
): Map<string, ExtOnServer> {
  const out = new Map<string, ExtOnServer>();
  const rows = db
    .select()
    .from(gclientExts)
    .where(eq(gclientExts.clientId, clientId))
    .all()
    .filter((r) => r.version !== null && r.enabled && now - Date.parse(r.seenAt) < EXT_ONLINE_MS);
  if (!rows.length) return out;
  const chain = (buildBrowserSubscription(db, token)?.servers ?? []).map((s) => s.id);
  for (const r of rows) {
    const auto = r.serverId === 'auto';
    const sid = auto ? chain.find(usable) : r.serverId;
    if (!sid || !chain.includes(sid)) continue;
    const prev = out.get(sid);
    if (prev && prev.seenAt >= r.seenAt) continue;
    out.set(sid, {
      browser: r.browser as GBrowserExt['browser'],
      version: r.version ?? '',
      auto,
      seenAt: r.seenAt,
    });
  }
  return out;
}
