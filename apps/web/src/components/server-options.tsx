import { serverOrigin } from '@/components/server-origin';
import type { ServerSummary } from '@vps/protocol';

/**
 * Серверы для Select: флаг и хостинг рядом с именем, не в сети - с пометкой (onlineOnly -
 * недоступны); withHost - с адресом.
 */
export function ServerOptions({
  servers,
  withHost,
  onlineOnly,
}: {
  servers: ServerSummary[] | undefined;
  withHost?: boolean;
  onlineOnly?: boolean;
}) {
  return (servers ?? []).map((s) => (
    <option key={s.id} value={s.id} disabled={onlineOnly && s.status !== 'online'}>
      {s.name}
      {serverOrigin(s.hosting) ? ` \u00b7 ${serverOrigin(s.hosting)}` : ''}
      {withHost ? `, ${s.host}` : ''}
      {s.status === 'online' ? '' : ' (не в сети)'}
    </option>
  ));
}
