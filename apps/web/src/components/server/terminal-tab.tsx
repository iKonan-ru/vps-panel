import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { InfoTip } from '@/components/ui/info-tip';
import type { ServerDetail } from '@/lib/servers';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Maximize2, Minimize2, Power, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

function b64encode(s: string): string {
  // кусками: fromCharCode(...все байты) на вставке в сотни КБ падает (слишком много аргументов)
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Id сессии терминала сервера: по нему панель подхватывает сессию после ухода со вкладки. */
const sidKey = (serverId: string) => `vps-term-sid:${serverId}`;
function loadSid(serverId: string): string {
  try {
    return localStorage.getItem(sidKey(serverId)) ?? '';
  } catch {
    return '';
  }
}
function saveSid(serverId: string, sid: string | null) {
  try {
    if (sid) localStorage.setItem(sidKey(serverId), sid);
    else localStorage.removeItem(sidKey(serverId));
  } catch {}
}

/** Код закрытия сокета "закрыть сессию сразу" (routes/terminal.ts). */
const CLOSE_EXPLICIT = 4000;

/**
 * Вкладка "Терминал": bash от root через агента. Ушли со вкладки, закрыли страницу или PWA -
 * сессия ждёт на панели 3 минуты и при возврате подхватывается с последним выводом; "Закрыть"
 * закрывает сразу. Каждая сессия пишется в журнал.
 */
export function TerminalTab({ s }: { s: ServerDetail }) {
  const online = s.status === 'online';
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [gen, setGen] = useState(0);
  // сессия подхвачена (вывод - повтор с панели), а не открыта заново
  const [resumed, setResumed] = useState(false);

  /** "Закрыть": сессия закрывается на сервере сразу, без ожидания возврата. */
  const closeNow = () => {
    saveSid(s.id, null);
    ws.current?.close(CLOSE_EXPLICIT, 'closed by user');
  };

  const connect = useCallback(() => {
    const el = box.current;
    if (!el) return;
    term.current?.dispose();
    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      theme: { background: '#0b0f14' },
      scrollback: 5000,
      // Ссылки OSC 8 в выводе: вывод - root-shell недоверенного сервера, а текст
      // ссылки может не совпадать с адресом. Только http(s), адрес показывается до перехода,
      // новая вкладка без доступа к окну панели.
      linkHandler: {
        activate: (_e, uri) => {
          if (!/^https?:\/\//i.test(uri)) return;
          if (!window.confirm(`Открыть ссылку из вывода сервера?\n\n${uri}`)) return;
          window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    f.fit();
    term.current = t;
    fit.current = f;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sid = loadSid(s.id);
    const sock = new WebSocket(
      `${proto}://${location.host}/ws/term/${s.id}?cols=${t.cols}&rows=${t.rows}${
        sid ? `&sid=${encodeURIComponent(sid)}` : ''
      }`,
    );
    ws.current = sock;
    setState('connecting');
    setNote(null);
    sock.onopen = () => setState('open');
    sock.onmessage = (ev) => {
      let m: {
        t: string;
        d?: string;
        code?: number;
        m?: string;
        sid?: string;
        resumed?: boolean;
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === 'data' && m.d) t.write(b64decode(m.d));
      else if (m.t === 'session' && m.sid) {
        saveSid(s.id, m.sid);
        setResumed(m.resumed === true);
      } else if (m.t === 'exit') {
        saveSid(s.id, null);
        setNote(`Оболочка завершилась (код ${m.code ?? 0})`);
      } else if (m.t === 'error') {
        saveSid(s.id, null);
        setNote(`Ошибка: ${m.m ?? ''}`);
      }
    };
    sock.onclose = (ev) => {
      setState('closed');
      if (ev.code === 4009) setNote('Сервер не в сети');
      else if (ev.code === 4001) setNote('Сессия панели истекла: нужно войти заново');
      else if (ev.code === 4010) setNote('Сессию подхватила другая вкладка или окно');
    };
    t.onData((d) => {
      if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ t: 'input', d: b64encode(d) }));
    });
    t.onResize(({ cols, rows }) => {
      if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ t: 'resize', cols, rows }));
    });
    t.focus();
  }, [s.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: gen - принудительное переподключение кнопкой
  useEffect(() => {
    if (!online) return;
    connect();
    const onResize = () => fit.current?.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      ws.current?.close();
      term.current?.dispose();
      term.current = null;
    };
  }, [connect, online, gen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: после смены размера контейнера подгоняем терминал
  useEffect(() => {
    const id = setTimeout(() => fit.current?.fit(), 50);
    return () => clearTimeout(id);
  }, [full]);

  if (!online) return <Card className="p-8 text-[13px] text-muted">Сервер не в сети</Card>;

  return (
    <div className={full ? 'fixed inset-0 z-40 flex flex-col bg-bg p-3' : 'flex flex-col gap-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          tone={state === 'open' ? 'ok' : state === 'connecting' ? 'accent' : 'muted'}
          dot={state === 'open'}
        >
          {state === 'open' ? 'подключено' : state === 'connecting' ? 'подключение' : 'закрыто'}
        </Chip>
        <span className="text-xs text-muted">
          root@{s.host}
          {resumed && state === 'open' ? ', сессия продолжена' : ''}
        </span>
        <InfoTip>Без открытой вкладки сессия живёт 3&nbsp;мин. Сессии пишутся в журнал.</InfoTip>
        <div className="grow" />
        {state === 'closed' && (
          <Button
            size="sm"
            onClick={() => setGen((g) => g + 1)}
            label="Подключить снова"
            short="Подключить"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        )}
        {state === 'open' && (
          <Button size="sm" onClick={closeNow} label="Закрыть" short="Закрыть">
            <Power className="size-3.5" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFull(!full)}
          title={full ? 'Свернуть' : 'На весь экран'}
        >
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>
      {note && <Alert>{note}</Alert>}
      <div
        ref={box}
        className={`min-h-0 overflow-hidden rounded-lg border border-border bg-[#0b0f14] p-2 ${full ? 'grow' : 'h-[60vh]'}`}
        onClick={() => term.current?.focus()}
        onKeyDown={() => undefined}
      />
    </div>
  );
}
