import { and, eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { awgClients, type servers } from '../db/schema.js';
import {
  type AwgConfigInput,
  type AwgVersion,
  amneziaKey,
  awgClientConf,
  awgTunnelNames,
  wgClientConf,
  wgCompatible,
} from './awg-config.js';
import { clientHost } from './client-host.js';
import type { SecretBox } from './secret-box.js';

/** Конфиги клиента AWG во всех форматах (окно клиента, глобальный клиент, личная страница). */
export interface AwgClientConfigs {
  version: string;
  conf: string;
  wg: string | null;
  vpn: string;
  frames: string[];
  /** Как подключение называется у клиента ("(флаг) Страна :: Хостинг"). */
  title: string;
  /** Имя .conf без расширения = имя туннеля в AmneziaWG ("FI-Hoster"). */
  fileName: string;
}

const where = (serverId: string, container: string, publicKey: string) =>
  and(
    eq(awgClients.serverId, serverId),
    eq(awgClients.container, container),
    eq(awgClients.publicKey, publicKey),
  );

/** Приватный ключ клиента, созданного панелью, - в базу (зашифрован), на сервер он не уходит. */
export async function awgSaveKey(
  db: Db,
  box: SecretBox,
  serverId: string,
  container: string,
  publicKey: string,
  privateKey: string,
) {
  await db
    .insert(awgClients)
    .values({ serverId, container, publicKey, privateKey: box.seal(privateKey) });
}

export async function awgForgetKey(db: Db, serverId: string, container: string, publicKey: string) {
  await db.delete(awgClients).where(where(serverId, container, publicKey));
}

/**
 * Конфиги клиента: параметры экземпляра - у агента (awg.config), приватный ключ - из базы. У
 * клиентов приложения Amnezia ключа нет нигде - ошибка 409. Клиент видит "(флаг) Страна ::
 * Хостинг".
 */
export async function awgClientConfigs(o: {
  db: Db;
  registry: AgentRegistry;
  box: SecretBox;
  server: typeof servers.$inferSelect;
  container: string;
  publicKey: string;
  mtu: number;
}): Promise<AwgClientConfigs> {
  const { server: row } = o;
  const d = await o.registry.request<{
    version: AwgVersion;
    port: number;
    address: string;
    params: { key: string; value: string }[];
    serverPublicKey: string;
    psk: string;
    clientIps: string;
    clientName: string;
  }>(
    row.id,
    'awg.config',
    { container: o.container, args: { publicKey: o.publicKey } },
    { timeoutMs: 60_000 },
  );
  const saved = (
    await o.db
      .select()
      .from(awgClients)
      .where(where(row.id, o.container, o.publicKey))
      .limit(1)
  )[0];
  if (!saved)
    throw Object.assign(
      new Error(
        'Приватного ключа клиента у панели нет (создан приложением Amnezia): конфиг выдать нельзя',
      ),
      { statusCode: 409 },
    );
  // дополнительный экземпляр - с версией в названии
  const extra = o.container !== 'amnezia-awg2' && o.container !== 'amnezia-awg';
  const names = awgTunnelNames({
    provider: row.provider,
    country: row.country,
    serverName: row.name,
    version: extra ? d.version : undefined,
  });
  const input: AwgConfigInput = {
    version: d.version,
    params: d.params,
    serverPublicKey: d.serverPublicKey,
    psk: d.psk,
    clientPrivateKey: o.box.open(saved.privateKey),
    clientPublicKey: o.publicKey,
    clientIps: d.clientIps,
    host: clientHost(row),
    port: d.port,
    mtu: o.mtu,
    dns: ['1.1.1.1', '1.0.0.1'],
    description: names.title,
    legacy: o.container === 'amnezia-awg',
    address: d.address,
  };
  const { key, frames } = amneziaKey(input);
  return {
    version: d.version,
    conf: awgClientConf(input),
    wg: wgCompatible(input) ? wgClientConf(input) : null,
    vpn: key,
    frames,
    title: names.title,
    fileName: names.file,
  };
}
