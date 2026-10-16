import { Button } from '@/components/ui/button';
import { Section } from '@/components/ui/section';
import { ApiError, api } from '@/lib/api';
import { cap } from '@/lib/format';
import { subscribe } from '@/lib/live';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface ActionRow {
  id: string;
  kind: string;
  output: string;
  exitCode: number | null;
  finishedAt: string | null;
}

/** Живой вывод действия: то, что уже в базе, плюс стрим по websocket. */
export function ActionOutput({
  actionId,
  onFinished,
  tall,
}: { actionId: string; onFinished?: (exitCode: number) => void; tall?: boolean }) {
  const [text, setText] = useState('');
  const [done, setDone] = useState<number | null>(null);
  // вывод не прочитан: действия нет в журнале (404) или ошибка запроса
  const [loadError, setLoadError] = useState<{ missing: boolean; text: string } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  // Колбэк в ref, чтобы новая функция при каждом рендере не переподписывала поток.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    let alive = true;
    let reported = false;
    setText('');
    setDone(null);
    setLoadError(null);
    // итог - один раз: из события или из базы, если действие кончилось до открытия
    const finish = (code: number) => {
      setDone(code);
      if (reported) return;
      reported = true;
      finished.current?.(code);
    };
    const load = () =>
      api<ActionRow>(`/api/actions/${actionId}`)
        .then((a) => {
          if (!alive) return;
          setLoadError(null);
          setText((t) => (t.length > a.output.length ? t : a.output));
          if (a.finishedAt && a.exitCode !== null) finish(a.exitCode);
        })
        .catch((e: Error) => {
          if (!alive) return;
          const missing = e instanceof ApiError && e.status === 404;
          setLoadError({
            missing,
            text: missing ? 'Действие не найдено в журнале' : cap(e.message),
          });
        });
    const un = subscribe((ev) => {
      // сокет переподключился: события за время обрыва (в том числе конец) потеряны
      if (ev.type === 'hello') return void load();
      if (ev.actionId !== actionId) return;
      if (ev.type === 'action.stream' && ev.chunk) setText((t) => t + ev.chunk);
      if (ev.type === 'action.finished' && typeof ev.exitCode === 'number') finish(ev.exitCode);
    });
    void load();
    return () => {
      alive = false;
      un();
    };
  }, [actionId]);

  // Следим за концом вывода только пока пользователь сам не прокрутил вверх:
  // иначе каждый новый кусок сбрасывал бы прокрутку вниз и прочитать начало было бы нельзя.
  const follow = useRef(true);
  const onScroll = () => {
    const el = box.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: прокрутка вниз при каждом новом куске текста
  useEffect(() => {
    if (follow.current) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [text]);

  return (
    <div className="flex flex-col gap-2">
      <pre
        ref={box}
        onScroll={onScroll}
        className={`${tall ? 'max-h-[70vh] min-h-[320px]' : 'max-h-[50vh] min-h-[160px]'} ${done === 0 ? 'console-ok' : ''} min-w-0 overflow-auto console rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]`}
      >
        {text ? (
          renderAnsi(text)
        ) : loadError ? (
          <span className="text-[#ff6b68]">{loadError.text}</span>
        ) : (
          <span className="text-[#8b95a3]">Ожидание вывода&hellip;</span>
        )}
      </pre>
      <div className={done === 0 ? 'text-xs text-ok' : 'text-xs text-muted'}>
        {done === null
          ? loadError?.missing
            ? 'Вывод недоступен'
            : 'Выполняется\u2026'
          : done === 0
            ? 'Завершено успешно'
            : `Завершено с ошибкой (код ${done})`}
      </div>
    </div>
  );
}

/**
 * Цвета ANSI: 30-37, 90-97 (жирный 1, сброс 0/39); прочие управляющие последовательности
 * убираются. Палитра своя, под тёмный фон .console, одинаковая в обеих темах.
 */
const ansiColors: Record<number, string> = {
  30: 'text-[#8b95a3]',
  31: 'text-[#ff6b68]',
  32: 'text-[#3ecf8e]',
  33: 'text-[#f2b544]',
  34: 'text-[#6ea8ff]',
  35: 'text-[#c792ea]',
  36: 'text-[#5fd7e8]',
  37: 'text-[#f5f7fa]',
  90: 'text-[#8b95a3]',
  91: 'text-[#ff6b68]',
  92: 'text-[#3ecf8e]',
  93: 'text-[#f2b544]',
  94: 'text-[#6ea8ff]',
  95: 'text-[#c792ea]',
  96: 'text-[#5fd7e8]',
  97: 'text-[#f5f7fa]',
};

/**
 * Превращает текст с ANSI-кодами в span-ы с цветами. Возврат каретки без перевода строки
 * (прогресс-бары установщиков) оставляет на строке только последний вариант.
 */
function renderAnsi(text: string) {
  const lines = text.split('\n').map((l) => {
    const parts = l.split('\r');
    return parts.length > 1 ? parts[parts.length - 1] || parts[parts.length - 2] || '' : l;
  });
  const out: React.ReactNode[] = [];
  let cls = '';
  let bold = false;
  let key = 0;
  const re = new RegExp(`${String.fromCharCode(27)}\\[([0-9;?]*)([A-Za-z])`, 'g');
  const src = lines.join('\n');
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const className = `${cls} ${bold ? 'font-semibold' : ''}`.trim();
    out.push(
      className ? (
        <span key={key++} className={className}>
          {chunk}
        </span>
      ) : (
        chunk
      ),
    );
  };
  for (const m of src.matchAll(re)) {
    push(src.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[2] !== 'm') continue; // не SGR: курсор, очистка строки и т.п.
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        cls = '';
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) cls = '';
      else if (ansiColors[code]) cls = ansiColors[code];
    }
  }
  push(src.slice(last));
  return out;
}

/** Секция с выводом запущенного действия и кнопкой "Скрыть" (вкладки сервера). */
export function ActionPanel({
  title,
  actionId,
  onHide,
  onFinished,
}: {
  title: string;
  actionId: string;
  onHide: () => void;
  onFinished?: (exitCode: number) => void;
}) {
  return (
    <Section
      title={title}
      actions={
        <Button size="sm" onClick={onHide} label="Скрыть">
          <X className="size-3.5" />
        </Button>
      }
    >
      <div className="p-4">
        <ActionOutput actionId={actionId} {...(onFinished ? { onFinished } : {})} />
      </div>
    </Section>
  );
}
