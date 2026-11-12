/** Ответ агента conns.list: подключения сервера по адресам (без имён - их подставляет панель). */
export interface ConnsListSnapshot {
  at: number;
  /** внешние TCP-порты сервисов: процесс-владелец, соединения и адреса */
  listeners: { port: number; process: string; conns: number; ips: number }[];
  /** адреса клиентов: соединения по портам и email пользователей xray с этим адресом */
  addrs: { ip: string; conns: number; ports: { port: number; conns: number }[]; users: string[] }[];
  /** пиры AWG с handshake за последние минуты и адрес, с которого они пришли */
  awg: {
    container: string;
    key: string;
    ip: string;
    handshake: number;
    rx: number;
    tx: number;
  }[];
  /** адресов больше, чем отдал агент: остались самые нагруженные */
  truncated: boolean;
  errors: Record<string, string>;
}

/**
 * Чей адрес: client - клиент панели (или пользователь 3X-UI); cascade - вход каскада (трафик всех
 * его клиентов); server - сервер из панели; unknown - ни один клиент панели и сервер его не знает.
 */
export type ConnKind = 'client' | 'cascade' | 'server' | 'unknown';

/** Пользователь xray за адресом: клиент панели, вход каскада или пользователь, которого в панели нет. */
export interface ConnUser {
  name: string;
  kind: 'client' | 'cascade' | 'other';
  /** карточка клиента панели или сервер входа каскада; нет - в панели не найден */
  clientId?: string;
  serverId?: string;
}

/** Порт с названием сервиса и числом соединений. */
export interface ConnPortView {
  port: number;
  /** сервис и подпись inbound-а ("3X-UI XHTTP"); пусто - порт не из каталога панели */
  label: string;
  conns: number;
}

/** Клиент панели, у которого этот адрес недавно был опознан (на этом или другом сервере). */
export interface ConnGuess {
  clientId: string;
  name: string;
  serverId: string;
  serverName: string;
  /** когда адрес видели у клиента последний раз */
  at: string;
}

export interface ConnAddrView {
  ip: string;
  kind: ConnKind;
  /** имя клиента, входа каскада или сервера; null - не опознан */
  name: string | null;
  /** сервер панели (kind server или cascade) и клиент (kind client, один) - для ссылки */
  serverId?: string;
  clientId?: string;
  users: ConnUser[];
  /** что это за адрес и откуда соединения, одной фразой */
  note: string;
  conns: number;
  ports: ConnPortView[];
  /**
   * Неопознанный адрес, который за последний час был у клиентов панели: предположительно их
   * устройство (адрес может делить и несколько абонентов оператора); свежие первыми
   */
  guess?: ConnGuess[];
}

export interface ConnPortSummary extends ConnPortView {
  /** процесс, слушающий порт */
  process: string;
  ips: number;
}

export interface ConnAwgView {
  ip: string;
  /** "Клиент, устройство" или "неизвестный пир" */
  name: string;
  kind: 'client' | 'unknown';
  clientId?: string;
  /** устройство клиента у привязки AWG */
  device?: string;
  handshakeAt: string;
  rx: number;
  tx: number;
}

/** Вкладка "Подключения" сервера. */
export interface ConnsView {
  at: string;
  /** клиентов на связи (как в плашке списка серверов); null - агент не определил */
  clients: number | null;
  conns: number;
  addresses: number;
  truncated: boolean;
  ports: ConnPortSummary[];
  addrs: ConnAddrView[];
  awg: ConnAwgView[];
  errors: Record<string, string>;
}

/** Тот же адрес клиента на другом сервере: опознан у этого клиента или виден неопознанным. */
export interface ClientConnElsewhere {
  serverId: string;
  serverName: string;
  kind: 'client' | 'unknown';
  /** соединений неопознанного адреса в последнем снимке сервера */
  conns?: number;
  at: string;
}

/** Адрес клиента на сервере: соединения с него, порты и чем он опознан. */
export interface ClientConnAddr {
  ip: string;
  /** соединений с адреса (у AWG соединений нет - 0) */
  conns: number;
  ports: ConnPortView[];
  /** чем опознан: "VLESS" или "AWG: устройство" */
  via: string[];
  /** AWG: последний handshake */
  handshakeAt?: string;
  elsewhere: ClientConnElsewhere[];
}

/** Адреса и подключения клиента на одном сервере (страница клиента на сервере). */
export interface ClientConnsView {
  /** время снимка; null - снимка нет (сервер не в сети или агент старый) */
  at: string | null;
  addrs: ClientConnAddr[];
  /** почему снимка нет */
  error?: string;
}
