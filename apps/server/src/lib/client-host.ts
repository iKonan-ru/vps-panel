import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Адрес сервера в конфигах людей (VLESS, AWG, WDTT, OpenFlux): имя под A-записью, если задано
 * (тогда смена IP - правка DNS), иначе IP из host. host - адрес для самой панели.
 */
export function clientHost(row: { host: string; clientHost?: string | null }): string {
  return row.clientHost || row.host;
}

/** Имя хоста для конфигов: латиница, цифры, дефисы, точки, хотя бы одна точка. */
export const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Публичные резолверы: смотрим, что видят люди, а не кэш сервера панели. */
const PUBLIC_DNS = ['77.88.8.8', '1.1.1.1', '8.8.8.8'];

/**
 * Адреса имени у публичных резолверов (A и AAAA, первый ответивший). Ошибка - текстом:
 * имени нет, резолверы не ответили.
 */
export async function resolvePublic(
  name: string,
): Promise<{ addresses: string[]; error?: string }> {
  let last = '';
  for (const server of PUBLIC_DNS) {
    const r = new Resolver({ timeout: 3000, tries: 1 });
    r.setServers([server]);
    const [v4, v6] = await Promise.allSettled([r.resolve4(name), r.resolve6(name)]);
    const addresses = [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : []),
    ];
    if (addresses.length) return { addresses };
    const err = (v4.status === 'rejected' ? v4.reason : null) as { code?: string } | null;
    // имени нет - ответ окончательный, другие резолверы спрашивать незачем
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA')
      return { addresses: [], error: `имени ${name} нет в DNS` };
    last = err?.code ?? 'нет ответа';
  }
  return { addresses: [], error: `DNS не ответил (${last})` };
}

/** Проверка имени для сервера: разрешается ли оно в его адрес. */
export async function checkClientHost(
  name: string,
  host: string,
): Promise<{ ok: boolean; addresses: string[]; error?: string }> {
  if (!HOSTNAME_RE.test(name) || isIP(name))
    return { ok: false, addresses: [], error: 'нужно имя вида srv.example.com' };
  const r = await resolvePublic(name);
  if (r.error) return { ok: false, addresses: [], error: r.error };
  const ok = r.addresses.includes(host);
  return {
    ok,
    addresses: r.addresses,
    ...(ok
      ? {}
      : {
          error: `${name} указывает на ${r.addresses.join(', ')}, а адрес сервера\u00a0\u2014 ${host}`,
        }),
  };
}

/**
 * Ссылка openflux:// канала: direct - на адрес для клиентов. Агент до 12.10 принимал только
 * IP ("нужен IP-адрес сервера для direct") - тогда та же ссылка на IP сервера.
 */
export async function openfluxLink(
  registry: {
    request<T>(id: string, op: string, payload: unknown, o?: { timeoutMs?: number }): Promise<T>;
  },
  row: { id: string; host: string; clientHost?: string | null },
  channel: string,
  name: string,
): Promise<{ link: string }> {
  const ask = (host: string) =>
    registry.request<{ link: string }>(
      row.id,
      'openflux.link',
      { channel, name, host },
      { timeoutMs: 60_000 },
    );
  const host = clientHost(row);
  try {
    return await ask(host);
  } catch (e) {
    if (host !== row.host && /нужен IP-адрес/.test((e as Error).message)) return ask(row.host);
    throw e;
  }
}
