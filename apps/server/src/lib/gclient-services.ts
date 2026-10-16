import { createHash, randomBytes } from 'node:crypto';
import { parseMtLinks } from '@vps/protocol';
import type { AgentRegistry } from '../agents/registry.js';
import { patchStatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import type { gclientBindings, gclientDevices, gclients, servers } from '../db/schema.js';
import { awgForgetKey, awgSaveKey } from './awg-clients.js';
import { awgTunnelNames } from './awg-config.js';
import { awgKeyPair } from './awg-keys.js';
import { clientHost, openfluxLink } from './client-host.js';
import { peerName } from './gclient-names.js';
import { takeOfDocs } from './openflux-docs.js';
import type { SecretBox } from './secret-box.js';
import { type WdttPassword, wdttApi, wdttHashes, wdttLinks } from './wdtt.js';
import { type XuiCall, ownVlessInbounds, readClient, unwrap } from './xui-api.js';

/**
 * Сервисы глобальных клиентов на сервере для сверки: завести или привести к клиенту и убрать -
 * пир AWG, пользователь MTProxyL, пароль WDTT, клиент 3X-UI, канал OpenFlux.
 */

type Client = typeof gclients.$inferSelect;
type Binding = typeof gclientBindings.$inferSelect;
type Device = typeof gclientDevices.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

export interface ServiceDeps {
  db: Db;
  box: SecretBox;
  registry: AgentRegistry;
}

/** subId клиента в 3X-UI; пустым он не бывает, но токен туда не уйдёт никогда. */
function xuiSubId(c: Client): string {
  if (!c.xuiSubId) throw new Error('у клиента нет subId 3X-UI');
  return c.xuiSubId;
}

/** VLESS через Vision: 3X-UI сама уберёт flow там, где он недопустим. */
const FLOW = 'xtls-rprx-vision';

export interface WdttList {
  passwords: WdttPassword[];
  dtlsPort: number;
  wgPort: number;
}
export interface MtStatus {
  secrets?: { label: string; secret?: string; enabled: boolean }[] | null;
}
interface AwgStatusInstance {
  container: string;
  version?: string;
  state?: string;
  clients?: {
    publicKey: string;
    name: string;
    device?: string;
    disabled: boolean;
    inConfig: boolean;
  }[];
}
export interface AwgStatus {
  instances?: AwgStatusInstance[];
  /** docker ответил: пустой список тогда значит "экземпляров нет", а не сбой опроса */
  docker?: boolean;
}

export interface OfStatus {
  channels?: {
    channel: string;
    state: string;
    enabled: boolean;
    transports?: { type: string }[];
  }[];
}

/**
 * Канал OpenFlux устройства: на канале одновременно работает один клиент
 * ("a new client took over the session" в журнале ноды), поэтому канал - на устройство. Имя -
 * из id устройства: тот же канал при каждой сверке, в формате node-install.sh.
 */
export function ofChannelName(deviceId: string) {
  return `vp-${createHash('sha256').update(deviceId).digest('hex').slice(0, 12)}`;
}

/** ref привязки AWG: "версия|контейнер|ключ" (пока пир не создан - "3||"). */
export function awgRef(ref: string) {
  const [major = '3', container = '', publicKey = ''] = ref.split('|');
  return { major, container, publicKey };
}

/**
 * Куда в 3X-UI добавлять клиента: свои VLESS-inbound-ы сервера (не других узлов группы 3X-UI),
 * включённые и не исключённые в панели. Если таких нет - reason с причиной для карточки клиента.
 */
export function xuiTargets(
  inbounds: Record<string, unknown>[],
  excluded: number[],
): { target: number[]; reason: string } {
  const own = ownVlessInbounds(inbounds);
  const isExcluded = (i: Record<string, unknown>) => excluded.includes(Number(i.id));
  const names = (list: Record<string, unknown>[]) =>
    list.map((i) => String(i.remark || `inbound ${i.id}`)).join(', ');
  const target = own.filter((i) => i.enable !== false && !isExcluded(i)).map((i) => Number(i.id));
  if (target.length) return { target, reason: '' };
  if (!own.length) return { target, reason: 'в 3X-UI нет своих inbound VLESS' };
  const off = own.filter((i) => i.enable === false && !isExcluded(i));
  const ex = own.filter(isExcluded);
  const parts = [
    ...(ex.length ? [`исключены на странице \u00abКлиенты\u00bb: ${names(ex)}`] : []),
    ...(off.length ? [`выключены в 3X-UI: ${names(off)}`] : []),
  ];
  return { target, reason: `некуда добавить VLESS\u00a0\u2014 ${parts.join('; ')}` };
}

/**
 * Ссылки VLESS привязки устарели: в отчёте агента, пришедшем после их получения, нет порта, на
 * который они указывают (inbound в самой 3X-UI перенесли на другой порт, выключили или удалили).
 */
export function xuiLinksOutdated(
  b: { links: string[]; updatedAt: string },
  inv: { at: string; ports: number[] } | null,
): boolean {
  if (!inv || Date.parse(inv.at) <= Date.parse(b.updatedAt)) return false;
  return b.links.some(
    (l) => !inv.ports.includes(Number(/@(?:\[[^\]]*\]|[^:/?#@]+):(\d+)/.exec(l)?.[1])),
  );
}

/** Экземпляры AWG сервера живым опросом (awg.status); заодно - в кэш для матрицы сервисов. */
export async function awgStatus(deps: ServiceDeps, serverId: string): Promise<AwgStatus> {
  const st = (await deps.registry.request(
    serverId,
    'awg.status',
    {},
    { timeoutMs: 60_000 },
  )) as AwgStatus;
  await patchStatusCache(deps.db, serverId, {
    awgInstances: (st.instances ?? []).map((i) => ({
      container: i.container,
      version: i.version ?? '',
      state: i.state ?? '',
    })),
  });
  return st;
}

/**
 * Пир AWG устройства на экземпляре нужной версии: создать (ключи - панель, приватный - в
 * базе) или привести к клиенту (вкл/выкл, имя "Имя (устройство)"). Пропал пир или экземпляр
 * сменился - пир заводится заново. Итог - ref "версия|контейнер|ключ".
 */
export async function awgEnsure(
  deps: ServiceDeps,
  serverId: string,
  st: AwgStatus,
  c: Client,
  d: Device,
  ref: string,
) {
  const { major, container, publicKey } = awgRef(ref);
  const fits = (i: AwgStatusInstance) => (i.version ?? '').startsWith(major);
  const cur = st.instances?.find((i) => i.container === container && fits(i));
  const inst =
    cur ??
    st.instances?.find((i) => i.container === 'amnezia-awg2' && fits(i)) ??
    st.instances?.find((i) => fits(i) && i.state === 'running') ??
    st.instances?.find(fits);
  if (!inst)
    throw new Error(
      `на сервере нет экземпляра AWG ${major}.x: его ставит команда \u00abAmnezia AWG\u00bb`,
    );
  const name = peerName(c, d);
  const exec = (op: string, args: Record<string, string>) =>
    deps.registry.request(
      serverId,
      'awg.exec',
      { op, container: inst.container, args },
      { timeoutMs: 60_000 },
    );
  const peer = publicKey && cur ? cur.clients?.find((p) => p.publicKey === publicKey) : undefined;
  if (!peer) {
    // старый пир (другой экземпляр или пропал) - убрать, ключ забыть
    if (publicKey && container) await awgRemove(deps, serverId, ref);
    const keys = awgKeyPair();
    await exec('client.add', { publicKey: keys.publicKey, name, device: d.type });
    await awgSaveKey(deps.db, deps.box, serverId, inst.container, keys.publicKey, keys.privateKey);
    if (!c.enabled) await exec('client.disable', { publicKey: keys.publicKey });
    return `${major}|${inst.container}|${keys.publicKey}`;
  }
  const off = peer.disabled || !peer.inConfig;
  if (c.enabled && off) await exec('client.enable', { publicKey });
  if (!c.enabled && !off) await exec('client.disable', { publicKey });
  if (peer.name !== name || (peer.device ?? '') !== d.type)
    await exec('client.rename', { publicKey, name, device: d.type });
  return ref;
}

/**
 * Пользователь MTProxyL клиента (метка - слаг): нет - создать с секретом от панели (32 hex,
 * хранится зашифрованным: по нему можно восстановить ссылки после переустановки), есть -
 * вкл/выкл по клиенту. Ссылки (tg:// и t.me) - в кэш для карточки и личной страницы.
 */
export async function mtEnsure(
  deps: ServiceDeps,
  serverId: string,
  st: MtStatus,
  c: Client,
  b: Binding,
) {
  const exec = async (op: string, args: Record<string, string>) =>
    (await deps.registry.request(
      serverId,
      'mtproxyl.exec',
      { op, args },
      { timeoutMs: 120_000 },
    )) as { output?: string };
  const user = st.secrets?.find((u) => u.label === b.ref);
  let secret = b.secret;
  if (!user) {
    const hex = randomBytes(16).toString('hex');
    await exec('secret.add', { label: b.ref, secret: hex });
    secret = deps.box.seal(hex);
    if (!c.enabled) await exec('secret.disable', { label: b.ref });
  } else if (user.enabled !== c.enabled)
    await exec(c.enabled ? 'secret.enable' : 'secret.disable', { label: b.ref });
  const links = parseMtLinks((await exec('secret.link', { label: b.ref })).output ?? '');
  return { secret, links };
}

/**
 * Пароль WDTT человека на сервере: создать (пароль генерирует сервер, у панели - в базе
 * зашифрованным) или привести к клиенту: подпись - имя, лимит устройств, срок 365 дней с
 * продлением за 30 дней до конца, вкл/выкл. Пропал на сервере (удалили руками, истёк) -
 * заводится заново: новый пароль уйдёт клиенту с подпиской. Итог - секрет и ссылки.
 */
export async function wdttEnsure(
  deps: ServiceDeps,
  row: ServerRow,
  st: WdttList,
  c: Client,
  b: Binding,
  maxDevices: number,
) {
  const post = (path: string, form: Record<string, string>) =>
    wdttApi(deps.registry, row.id, 'POST', path, form);
  let password = b.secret ? deps.box.open(b.secret) : '';
  let entry = password ? st.passwords.find((p) => p.password === password) : undefined;
  if (!entry) {
    const r = await post('/admin/passwords', {
      label: c.name,
      max_devices: String(maxDevices),
      days: '365',
      // хеш серверу обязателен, но для входа не нужен (только для ссылок бота)
      vk_hash: wdttHashes(deps.db)[0] ?? '-',
    });
    entry = r.data as WdttPassword;
    password = entry.password;
    st.passwords.push(entry);
  } else {
    const form: Record<string, string> = {};
    if (entry.label !== c.name) form.label = c.name;
    if (entry.max_devices !== maxDevices) form.max_devices = String(maxDevices);
    if (entry.expires_at && entry.expires_at * 1000 - Date.now() < 30 * 86_400_000)
      form.days = '365';
    if (Object.keys(form).length) await post('/admin/passwords/update', { password, ...form });
  }
  if (c.enabled === Boolean(entry.is_deactivated))
    await post(c.enabled ? '/admin/passwords/activate' : '/admin/passwords/deactivate', {
      password,
    });
  const name = awgTunnelNames({
    provider: row.provider,
    country: row.country,
    serverName: row.name,
  }).title;
  const l = wdttLinks({
    host: clientHost(row),
    dtlsPort: st.dtlsPort,
    wgPort: st.wgPort,
    password,
    hashes: wdttHashes(deps.db),
    name,
  });
  return { secret: deps.box.seal(password), links: [l.qwdtt, l.wdtt] };
}

/** Ключ пароля WDTT для сопоставления во вкладке (GOwner): 16 hex sha256, не сам пароль. */
export function wdttKey(password: string) {
  return createHash('sha256').update(password).digest('hex').slice(0, 16);
}

export async function wdttRemove(deps: ServiceDeps, serverId: string, b: Binding) {
  if (!b.secret) return;
  try {
    await wdttApi(deps.registry, serverId, 'POST', '/admin/passwords/delete', {
      password: deps.box.open(b.secret),
    });
  } catch (e) {
    // уже нет - тоже успех
    if (!/not found|не найден/i.test((e as Error).message)) throw e;
  }
}

export async function mtRemove(deps: ServiceDeps, serverId: string, label: string) {
  try {
    await deps.registry.request(
      serverId,
      'mtproxyl.exec',
      { op: 'secret.remove', args: { label } },
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    // уже нет - тоже успех
    if (!/не найден|not found/i.test((e as Error).message)) throw e;
  }
}

export async function awgRemove(deps: ServiceDeps, serverId: string, ref: string) {
  const { container, publicKey } = awgRef(ref);
  if (!container || !publicKey) return;
  try {
    await deps.registry.request(
      serverId,
      'awg.exec',
      { op: 'client.remove', container, args: { publicKey } },
      { timeoutMs: 60_000 },
    );
  } catch (e) {
    // уже нет (удалили руками или вместе с контейнером) - тоже успех
    if (!/не найден|нет такого|no such/i.test((e as Error).message)) throw e;
  }
  await awgForgetKey(deps.db, serverId, container, publicKey);
}

/**
 * Клиент в 3X-UI v3 (3.1+): создать или привязать к нужным inbound-ам, отвязать от лишних,
 * затем полной записью - вкл/выкл, subId (свой, не токен клиента), Vision (attach берёт flow из старых
 * привязок, а update заменяет запись целиком). Итог - ссылки для подписки.
 */
export async function xuiEnsure(api: XuiCall, c: Client, email: string, target: number[]) {
  const got = await api('GET', `clients/get/${encodeURIComponent(email)}`);
  if (got.status === 404)
    throw new Error('3X-UI старше 3.1 (нет API клиентов): нужно обновить 3X-UI');
  let existing = (got.data as { success?: boolean } | undefined)?.success
    ? readClient((got.data as { obj?: unknown }).obj)
    : null;
  if (!existing) {
    unwrap(
      await api('POST', 'clients/add', {
        client: { email, enable: c.enabled, flow: FLOW, subId: xuiSubId(c), comment: c.name },
        inboundIds: target,
      }),
      'clients/add',
    );
    existing = readClient(
      unwrap(await api('GET', `clients/get/${encodeURIComponent(email)}`), 'clients/get'),
    );
    if (!existing) throw new Error('3X-UI не вернула созданного клиента');
  } else {
    const add = target.filter((id) => !existing?.inboundIds.includes(id));
    const del = existing.inboundIds.filter((id) => !target.includes(id));
    if (add.length)
      unwrap(
        await api('POST', `clients/${encodeURIComponent(email)}/attach`, { inboundIds: add }),
        'attach',
      );
    if (del.length)
      unwrap(
        await api('POST', `clients/${encodeURIComponent(email)}/detach`, { inboundIds: del }),
        'detach',
      );
  }
  unwrap(
    await api('POST', `clients/update/${encodeURIComponent(email)}`, {
      id: existing.uuid,
      email,
      enable: c.enabled,
      flow: FLOW,
      subId: xuiSubId(c),
      comment: c.name,
      limitIp: 0,
      totalGB: 0,
      expiryTime: 0,
      tgId: 0,
      reset: 0,
    }),
    'clients/update',
  );
  const links = unwrap(await api('GET', `clients/subLinks/${xuiSubId(c)}`), 'subLinks');
  return Array.isArray(links)
    ? links.map(String)
    : String(links ?? '')
        .split('\n')
        .filter(Boolean);
}

export async function xuiRemove(api: XuiCall, email: string) {
  const r = await api('POST', `clients/del/${encodeURIComponent(email)}`);
  const env = r.data as { success?: boolean; msg?: string } | undefined;
  // уже нет - тоже успех
  if (r.status === 200 && (env?.success || /not found|не найден/i.test(env?.msg ?? ''))) return;
  throw new Error(`3X-UI (clients/del): ${env?.msg ?? r.status}`);
}

/**
 * Канал OpenFlux устройства на сервере. Транспорты: документы из пула
 * (Яндекс, Mail.ru - по одному на канал, если в пуле есть свободные), комнаты cups.online
 * (создаёт сервер) и прямое подключение. Нет канала - создать; есть, но транспорты не те -
 * перенастроить (ключ и порт остаются; ссылка новая: с документом меняется контекст
 * шифрования); вкл/выкл по клиенту. Какие документы стоят в канале - в secret привязки
 * (зашифровано). Комнаты не создались (cups.online ограничивает частоту) - канал работает без
 * них, причина - в warning, повтор - позже. Имя профиля - "флаг Страна :: Хостинг".
 */
export async function ofEnsure(
  deps: ServiceDeps,
  row: ServerRow,
  st: OfStatus,
  c: Client,
  b: Binding,
  /** Общее на проход по серверу: cups.online уже отказал - комнаты не просить. */
  pass: { cupsOff: boolean } = { cupsOff: false },
): Promise<{ links: string[]; secret: string; warning: string }> {
  const exec = (json: Record<string, unknown>) =>
    deps.registry.request<Record<string, unknown>>(row.id, 'openflux.exec', json, {
      timeoutMs: 10 * 60_000,
    });
  const want = takeOfDocs(deps.db, b.id);
  const had = b.secret
    ? (JSON.parse(deps.box.open(b.secret)) as { vyandex?: string; mailru?: string })
    : null;
  let ch = st.channels?.find((x) => x.channel === b.ref);
  let links = b.links;
  let warning = '';
  const cupsLater = 'cups.online ограничил частоту, канал пока без комнат, повтор позже';
  if (!ch) {
    try {
      const r = await exec({
        op: 'create',
        channel: b.ref,
        ...want,
        cupsonline: pass.cupsOff ? '' : 'auto',
      });
      if (r.cupsonline !== true) {
        warning = pass.cupsOff
          ? cupsLater
          : 'cups.online не выдал комнаты, канал пока без них, повтор позже';
        pass.cupsOff = true;
      }
      if (!c.enabled) await exec({ op: 'disable', channel: b.ref });
      links = [];
    } catch (e) {
      // канал появился после снимка состояния (его досоздал прерванный прошлый проход) -
      // дальше как с существующим
      if (!/уже есть на сервере/.test((e as Error).message)) throw e;
      const fresh = await deps.registry.request<OfStatus>(
        row.id,
        'openflux.status',
        {},
        { timeoutMs: 60_000 },
      );
      ch = fresh.channels?.find((x) => x.channel === b.ref);
      if (!ch) throw e;
      links = [];
    }
  }
  if (ch) {
    const types = new Set((ch.transports ?? []).map((t) => t.type));
    const docsChanged =
      want.vyandex !== (had?.vyandex ?? '') ||
      want.mailru !== (had?.mailru ?? '') ||
      Boolean(want.vyandex) !== types.has('vyandex') ||
      Boolean(want.mailru) !== types.has('mailru');
    const needCups = !types.has('cupsonline') && !pass.cupsOff;
    if (!types.has('cupsonline') && pass.cupsOff) warning = cupsLater;
    if (docsChanged || needCups) {
      try {
        await exec({
          op: 'configure',
          channel: b.ref,
          ...want,
          cupsonline: needCups ? 'auto' : 'keep',
        });
        links = [];
      } catch (e) {
        if (!needCups) throw e;
        warning = `cups.online: ${(e as Error).message}`;
        pass.cupsOff = true;
        if (docsChanged) {
          await exec({ op: 'configure', channel: b.ref, ...want, cupsonline: 'keep' });
          links = [];
        }
      }
    }
    if (ch.enabled !== c.enabled)
      await exec({ op: c.enabled ? 'enable' : 'disable', channel: b.ref });
  }
  if (!links.length) {
    const title = awgTunnelNames({
      provider: row.provider,
      country: row.country,
      serverName: row.name,
    }).title;
    const r = await openfluxLink(deps.registry, row, b.ref, title);
    links = [r.link];
  }
  return { links, secret: deps.box.seal(JSON.stringify(want)), warning };
}

export async function ofRemove(deps: ServiceDeps, serverId: string, ref: string) {
  try {
    await deps.registry.request(
      serverId,
      'openflux.exec',
      { op: 'remove', channel: ref },
      { timeoutMs: 5 * 60_000 },
    );
  } catch (e) {
    // уже нет - тоже успех
    if (!/нет на сервере|не установлен/i.test((e as Error).message)) throw e;
  }
}

/** Состояние прокси для браузера на сервере (naive.status). */
export interface NaiveStatus {
  installed?: boolean;
  active?: string;
  domain?: string;
  port?: number;
  secret?: string;
  listen443?: boolean;
  mask443?: boolean;
  users?: string[];
  error?: string;
}

/** Пароль прокси: 24 латинских буквы и цифры (агент принимает 16-64). */
export function naivePassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...randomBytes(24)].map((b) => abc[b % abc.length]).join('');
}

/**
 * Ссылка прокси для браузера: naive+https://<пользователь>:<пароль>@<имя>:<порт>#<подпись> -
 * формат клиентов NaiveProxy (NekoBox и др.). Свои параметры расширения - в query: p443=1 (прокси
 * отвечает и на 443), probe=<секретное имя> (на него прокси просит пароль, прогрев в расширении).
 */
export function naiveLink(o: {
  user: string;
  password: string;
  domain: string;
  port: number;
  on443: boolean;
  secret: string;
  title: string;
}): string {
  const q = new URLSearchParams({ probe: o.secret });
  if (o.on443) q.set('p443', '1');
  return `naive+https://${o.user}:${o.password}@${o.domain}:${o.port}?${q}#${encodeURIComponent(o.title)}`;
}

/** Разбор ссылки naiveLink (подписка расширения, личная страница). */
export function parseNaiveLink(link: string) {
  const m = /^naive\+https:\/\/([^:@/]+):([^@/]+)@([^:/?#]+):(\d+)\?([^#]*)(?:#(.*))?$/.exec(link);
  if (!m) return null;
  const q = new URLSearchParams(m[5]);
  let title = m[6] ?? '';
  try {
    title = decodeURIComponent(title);
  } catch {
    // подпись как есть
  }
  const port = Number(m[4]);
  return {
    user: m[1] ?? '',
    password: m[2] ?? '',
    host: m[3] ?? '',
    port,
    ports: q.get('p443') === '1' ? [443, port] : [port],
    probe: q.get('probe') ?? '',
    title,
  };
}

/**
 * Прокси для браузера: пользователь на сервере - слаг клиента, пароль -
 * случайный, в базе зашифрованным. Выключенный клиент - пользователя на сервере нет (пароль
 * остаётся в базе: включили - тот же). Итог - секрет и ссылка для подписки расширения.
 */
export async function naiveEnsure(
  deps: ServiceDeps,
  row: ServerRow,
  st: NaiveStatus,
  c: Client,
  b: Binding,
) {
  if (!st.domain || !st.port || !st.secret)
    throw new Error(st.error || 'прокси для браузера на сервере не настроен');
  const password = b.secret ? deps.box.open(b.secret) : naivePassword();
  const exec = (op: string, args: Record<string, string>) =>
    deps.registry.request(row.id, 'naive.exec', { op, ...args }, { timeoutMs: 90_000 });
  if (c.enabled) await exec('user.set', { user: b.ref, pass: password });
  else if (st.users?.includes(b.ref)) await exec('user.remove', { user: b.ref });
  const title = awgTunnelNames({
    provider: row.provider,
    country: row.country,
    serverName: row.name,
  }).title;
  const link = naiveLink({
    user: b.ref,
    password,
    domain: st.domain,
    port: st.port,
    on443: Boolean(st.listen443 || st.mask443),
    secret: st.secret,
    title,
  });
  return { secret: deps.box.seal(password), links: [link] };
}

export async function naiveRemove(deps: ServiceDeps, serverId: string, user: string) {
  await deps.registry.request(
    serverId,
    'naive.exec',
    { op: 'user.remove', user },
    { timeoutMs: 90_000 },
  );
}
