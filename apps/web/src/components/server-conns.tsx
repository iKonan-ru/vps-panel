import { Section } from '@/components/ui/section';
import type { Metrics, ServerDetail } from '@vps/protocol';

/** Клиентов на связи: уникальные адреса TCP и пиры AWG; агент без адресов - нет числа. */
const clientsOf = (c: NonNullable<Metrics['conns']>) =>
  c.ips === undefined ? null : c.ips + c.awg;

/** Подключения клиентов к серверу сейчас: "клиентов 23, подключений 1712"; нет счётчика - ничего. */
export function ServerConns({
  m,
  short = false,
}: { m: Metrics | null | undefined; short?: boolean }) {
  if (!m?.conns) return null;
  const { tcp, awg } = m.conns;
  const clients = clientsOf(m.conns);
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={`Сейчас: TCP-соединений ${tcp} (внешние порты сервисов, кроме SSH), пиров AWG ${awg}. Клиент: уникальный адрес. За одним адресом (NAT, мобильная сеть) может быть несколько человек, а у одного человека бывает несколько адресов`}
    >
      {clients !== null && (
        <>
          {short ? 'кл.' : 'клиентов'} {clients},{' '}
        </>
      )}
      {short ? 'подкл.' : 'подключений'} {tcp + awg}
    </span>
  );
}

/** Название порта: сервис и подпись inbound-а из списка портов инвентаря ("443/tcp Remark"). */
function portLabel(s: ServerDetail, port: number): string {
  for (const sv of s.services) {
    const hit = sv.ports.find((p) => p.startsWith(`${port}/`));
    if (hit) return [sv.title, ...hit.split(' ').slice(1)].join(' ');
  }
  return 'порт без сервиса';
}

/** Разбивка подключений по портам: понять, какой сервис и сколько адресов за ними. */
export function ConnsSection({ s }: { s: ServerDetail }) {
  const c = s.metrics?.conns;
  if (s.status !== 'online' || !c) return null;
  return (
    <Section title="Подключения">
      {(c.ports ?? []).map((p) => (
        <div
          key={p.port}
          className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
        >
          <div className="min-w-0 grow">
            <span className="font-mono">{p.port}</span>{' '}
            <span className="text-muted">{portLabel(s, p.port)}</span>
          </div>
          <div className="shrink-0 tabular-nums">
            {p.conns}
            <span className="text-xs text-muted"> соед., </span>
            {p.ips}
            <span className="text-xs text-muted"> адр.</span>
          </div>
        </div>
      ))}
      {c.awg > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
          <div className="grow text-muted">AWG: пиры с handshake за 3 минуты</div>
          <div className="tabular-nums">{c.awg}</div>
        </div>
      )}
      {(c.top ?? []).length > 0 && (
        <div className="border-t border-border px-4 pt-2.5 pb-1 text-xs text-muted">
          Больше всего соединений: вход каскада объединяет трафик всех своих клиентов
        </div>
      )}
      {(c.top ?? []).map((u) => (
        <div
          key={u.ref}
          className="flex items-center gap-3 px-4 py-2 text-[13px]"
          title={u.name ? u.ref : undefined}
        >
          <div className="min-w-0 grow truncate">
            {u.kind === 'cascade' ? (
              <>
                <span className="text-muted">вход каскада</span> {u.name}
              </>
            ) : (
              (u.name ?? <span className="font-mono text-xs">{u.ref}</span>)
            )}
          </div>
          <div className="shrink-0 tabular-nums">
            {u.conns}
            <span className="text-xs text-muted"> соед., </span>
            {u.ips}
            <span className="text-xs text-muted"> адр.</span>
          </div>
        </div>
      ))}
      {(c.ports ?? []).length === 0 && c.awg === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">Подключений нет</div>
      )}
    </Section>
  );
}
