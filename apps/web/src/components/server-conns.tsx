import type { Metrics } from '@vps/protocol';

/** Подключения клиентов к серверу сейчас: "подключений 12"; агент без счётчика - ничего. */
export function ServerConns({
  m,
  short = false,
}: { m: Metrics | null | undefined; short?: boolean }) {
  if (!m?.conns) return null;
  const { tcp, awg } = m.conns;
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={`Клиенты сейчас: TCP-соединений ${tcp} (VLESS, MTProxy, WDTT, OpenFlux и другие внешние порты, кроме SSH), пиров AWG ${awg}`}
    >
      {short ? 'подкл.' : 'подключений'} {tcp + awg}
    </span>
  );
}
