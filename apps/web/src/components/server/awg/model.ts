/** Экземпляры AmneziaWG сервера и их клиенты: ответ агента (awg.status) и подписи. */

interface AwgParam {
  key: string;
  value: string;
  commented?: boolean;
}

export interface AwgClient {
  publicKey: string;
  name: string;
  /** Код из DEVICES; у клиентов из приложения Amnezia - нет. */
  device?: string;
  created: string;
  allowedIps: string;
  inConfig: boolean;
  inTable: boolean;
  disabled: boolean;
  /** Приватный ключ у панели: конфиг можно выдать. */
  managed?: boolean;
  endpoint: string;
  handshake: number;
  rx: number;
  tx: number;
}

export interface AwgInstance {
  container: string;
  state: string;
  confPath: string;
  iface: string;
  port: number;
  address: string;
  params: AwgParam[];
  version: string;
  publicKey: string;
  impl: string;
  tools: string;
  clients: AwgClient[];
  tableError?: string;
  error?: string;
}

export interface AwgStatus {
  instances: AwgInstance[];
  hostModule: string;
}

/** Клиент на связи: последний handshake не старше 3 минут (WireGuard обновляет его раз в 2). */
export const isOnline = (c: AwgClient) => c.handshake > 0 && Date.now() / 1000 - c.handshake < 180;

export const versionTitles: Record<string, string> = {
  '3.1': 'AWG 3.1',
  '3.0': 'AWG 3.0',
  '2.0': 'AWG 2.0',
  '1.5': 'AWG 1.5',
  '1.0': 'AWG 1.0',
  wg: 'WireGuard',
};

/** Имя клиента для списка: из clientsTable, иначе IP ("внешний" пир без записи). */
export function clientTitle(c: AwgClient): string {
  return c.name || c.allowedIps.split(',')[0]?.replace('/32', '') || c.publicKey.slice(0, 8);
}
