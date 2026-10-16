import type { ServerSummary } from '@vps/protocol';

/**
 * Варианты выбора сервера для Select: имя (withHost - и адрес), сервер не в сети - с пометкой;
 * onlineOnly - его нельзя выбрать.
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
      {withHost ? `, ${s.host}` : ''}
      {s.status === 'online' ? '' : ' (не в сети)'}
    </option>
  ));
}
