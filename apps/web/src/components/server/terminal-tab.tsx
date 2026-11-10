import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { InfoTip } from '@/components/ui/info-tip';
import { LoadState } from '@/components/ui/placeholder';
import type { ServerDetail } from '@vps/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eraser,
  Maximize2,
  Minimize2,
  Power,
  RefreshCw,
} from 'lucide-react';
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

/** Клавиши, которых нет на экранной клавиатуре телефона: подпись, что отправить, подсказка. */
const KEYS: [label: string, data: string, title: string][] = [
  ['Esc', '\x1b', 'Escape'],
  ['Tab', '\t', 'Дополнить ввод'],
  ['Ctrl+C', '\x03', 'Прервать текущую команду'],
  ['Home', '\x1b[H', 'В начало строки'],
  ['End', '\x1b[F', 'В конец строки'],
  ['PgUp', '\x1b[5~', 'Страница вверх'],
  ['PgDn', '\x1b[6~', 'Страница вниз'],
  ['|', '|', 'Вертикальная черта'],
  ['/', '/', 'Косая черта'],
  ['-', '-', 'Дефис'],
  ['~', '~', 'Тильда'],
];
/** Стрелки: в приложениях (vim, less) терминал ждёт другой префикс, чем в оболочке. */
const ARROWS = [
  ['A', ArrowUp, 'Вверх, предыдущая команда'],
  ['B', ArrowDown, 'Вниз, следующая команда'],
  ['D', ArrowLeft, 'Влево'],
  ['C', ArrowRight, 'Вправо'],
] as const;

/** Код закрытия сокета "закрыть сессию сразу" - тот же, что у сервера. */
const CLOSE_EXPLICIT = 4000;

/** Терминал root через агента; ушли со вкладки - сессия ждёт на панели 3 минуты. */
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
  // Ctrl с экрана: следующая набранная буква уходит как Ctrl+буква
  const [ctrl, setCtrlState] = useState(false);
  const ctrlRef = useRef(false);
  const setCtrl = (on: boolean) => {
    ctrlRef.current = on;
    setCtrlState(on);
  };

  /** "Закрыть": сессия закрывается на сервере сразу, без ожидания возврата. */
  const closeNow = () => {
    saveSid(s.id, null);
    ws.current?.close(CLOSE_EXPLICIT, 'closed by user');
  };

  const sendInput = (data: string) => {
    const socket = ws.current;
    if (state !== 'open' || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: 'input', d: b64encode(data) }));
    term.current?.focus();
  };
  const ask = useConfirm();
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
      // ссылки OSC 8 - из root-shell недоверенного сервера, текст может не совпадать с адресом:
      // только http(s), адрес - до перехода, новая вкладка без доступа к окну панели
      linkHandler: {
        activate: async (_e, uri) => {
          if (!/^https?:\/\//i.test(uri)) return;
          const ok = await ask({
            title: 'Открыть ссылку из вывода сервера?',
            text: <span className="font-mono break-all">{uri}</span>,
            okLabel: 'Открыть',
          });
          if (ok) window.open(uri, '_blank', 'noopener,noreferrer');
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
    sock.onmessage = (ev) => {
      if (ws.current !== sock) return;
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
        setState('open');
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
      if (ws.current !== sock) return;
      setState('closed');
      if (ev.code === 4009) setNote('Сервер не в сети');
      else if (ev.code === 4001) setNote('Сессия панели истекла: нужно войти заново');
      else if (ev.code === 4010) setNote('Сессию подхватила другая вкладка или окно');
    };
    t.onData((d) => {
      let data = d;
      if (ctrlRef.current && d.length === 1) {
        const code = d.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) data = String.fromCharCode(code - 96);
        ctrlRef.current = false;
        setCtrlState(false);
      }
      if (sock.readyState === sock.OPEN)
        sock.send(JSON.stringify({ t: 'input', d: b64encode(data) }));
    });
    t.onResize(({ cols, rows }) => {
      if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ t: 'resize', cols, rows }));
    });
    t.focus();
  }, [s.id, ask]);

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

  if (!online) return <LoadState offline />;

  return (
    <div className={full ? 'fixed inset-0 z-25 flex flex-col bg-bg p-3' : 'flex flex-col gap-3'}>
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
      {/* клавиши без экранной клавиатуры: ряд прокручивается, фокус остаётся в терминале */}
      <div
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        aria-label="Клавиши терминала"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Button
          size="sm"
          variant={ctrl ? 'primary' : 'default'}
          aria-pressed={ctrl}
          disabled={state !== 'open'}
          title="Следующая буква уйдёт как Ctrl+буква"
          onClick={() => {
            setCtrl(!ctrl);
            term.current?.focus();
          }}
        >
          Ctrl
        </Button>
        {KEYS.slice(0, 3).map(([label, data, title]) => (
          <Button
            key={label}
            size="sm"
            disabled={state !== 'open'}
            title={title}
            onClick={() => sendInput(data)}
          >
            {label}
          </Button>
        ))}
        {ARROWS.map(([code, Icon, title]) => (
          <Button
            key={code}
            size="sm"
            disabled={state !== 'open'}
            title={title}
            aria-label={title}
            onClick={() =>
              sendInput(
                `${term.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${code}`,
              )
            }
          >
            <Icon className="size-3.5" />
          </Button>
        ))}
        {KEYS.slice(3).map(([label, data, title]) => (
          <Button
            key={label}
            size="sm"
            disabled={state !== 'open'}
            title={title}
            onClick={() => sendInput(data)}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          title="Очистить экран и историю вывода"
          onClick={() => {
            term.current?.clear();
            sendInput('\x0c');
            term.current?.focus();
          }}
        >
          <Eraser className="size-3.5" />
          Очистить
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
