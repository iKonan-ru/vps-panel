import { Chip } from '@/components/ui/chip';
import { plural } from '@/lib/format';
import { Link } from '@tanstack/react-router';
import type { Metrics, ServerSummary } from '@vps/protocol';
import { Users } from 'lucide-react';

/**
 * Клиентов на связи: пользователи VLESS, MTProxy, WDTT и пиры AWG (агент считает сам); старый
 * агент - уникальные адреса TCP и пиры AWG; нет счётчика - null.
 */
export function clientsOf(m: Metrics | null | undefined): number | null {
  const c = m?.conns;
  if (!c) return null;
  if (c.clients !== undefined) return c.clients;
  return c.ips === undefined ? null : c.ips + c.awg;
}

const CLIENTS_HINT =
  'Клиенты на связи сейчас: пользователи VLESS, MTProxy и WDTT с активным соединением и пиры AWG. Вход каскада считается не клиентом, а сервером';

/**
 * Плашка "N клиентов" рядом со статусом сервера: синяя, как плашки сервисов, чтобы не путать с
 * зелёным "в сети"; нет клиентов - серая; сервер не в сети или агент без счётчика - ничего.
 */
export function ClientsChip({ s }: { s: ServerSummary }) {
  const n = s.status === 'online' ? clientsOf(s.metrics) : null;
  if (n === null) return null;
  return (
    // ссылка на вкладку "Подключения": кто именно на связи
    <Link
      to="/servers/$id/$tab"
      params={{ id: s.id, tab: 'conns' }}
      title={`${CLIENTS_HINT}. Открыть подключения`}
    >
      <Chip tone={n > 0 ? 'accent' : 'muted'}>
        <Users className="size-3" />
        <span className="tabular-nums">{n}</span>
        <span className="max-md:hidden">{plural(n, 'клиент', 'клиента', 'клиентов')}</span>
      </Chip>
    </Link>
  );
}

/** Шапка сервера: "клиентов 23"; нет счётчика - ничего. */
export function ServerConns({ m }: { m: Metrics | null | undefined }) {
  const clients = clientsOf(m);
  if (clients === null) return null;
  return (
    <span className="whitespace-nowrap tabular-nums" title={CLIENTS_HINT}>
      клиентов {clients}
    </span>
  );
}
