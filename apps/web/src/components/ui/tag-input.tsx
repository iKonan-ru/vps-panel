import { TagChip } from '@/components/ui/tag-chip';
import { cn } from '@/lib/cn';
import { tagColorOf, tagKey } from '@/lib/tags';
import { usePresence } from '@/lib/use-presence';
import { TAG_MAX, type Tag, normTag } from '@vps/protocol';
import { Plus } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Теги сервера: плашки с крестиком и поле ввода. Подсказки - теги из справочника, которых ещё
 * нет; новый тег - Enter, запятая или уход из поля. Enter в пустом поле отправляет форму.
 */
export function TagInput({
  id,
  value,
  onChange,
  tags,
  disabled,
  placeholder = 'Добавить тег',
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  tags: Tag[] | undefined;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  // выделенный пункт подсказок; -1 - никакого (Enter в пустом поле - отправка формы)
  const [hl, setHl] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(
    null,
  );
  const listId = useId();
  const color = tagColorOf(tags, value);

  const chosen = new Set(value.map(tagKey));
  const needle = tagKey(normTag(text));
  const options = (tags ?? [])
    .filter((t) => !chosen.has(tagKey(t.name)) && tagKey(t.name).includes(needle))
    .map((t) => t.name);
  const exact = needle !== '' && (options.some((n) => tagKey(n) === needle) || chosen.has(needle));
  // новый тег - последним пунктом: выбрать существующий проще, чем создать похожий
  const items: { name: string; fresh: boolean }[] = [
    ...options.map((n) => ({ name: n, fresh: false })),
    ...(needle && !exact ? [{ name: normTag(text), fresh: true }] : []),
  ];
  const open = focused && !disabled && items.length > 0;
  const { shown, closing } = usePresence(open);
  // пока список закрывается, в нём остаются последние пункты
  const last = useRef(items);
  if (open) last.current = items;
  const view = open ? items : last.current;
  const active = Math.min(hl, items.length - 1);

  // список - в портале поверх всего (карточки ниже и края окна его не перекрывают): место под
  // полем, не хватает - над ним; следует за полем при прокрутке и смене размеров
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const h = list.current?.offsetHeight ?? 240;
      const up = r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8;
      setPos({ top: up ? r.top - 4 - h : r.bottom + 4, left: r.left, width: r.width, up });
    };
    place();
    // поле растёт от новых плашек, список - от числа подсказок
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    if (list.current) ro.observe(list.current);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown]);

  /** Добавить теги (вставка "a, b, c" - сразу несколько); имя из справочника - в его написании. */
  function add(...raw: string[]) {
    setText('');
    setHl(-1);
    const next = [...value];
    for (const r of raw) {
      const n = normTag(r);
      if (!n || next.some((x) => tagKey(x) === tagKey(n))) continue;
      next.push(tags?.find((t) => tagKey(t.name) === tagKey(n))?.name ?? n);
    }
    if (next.length > value.length) onChange(next);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const it = active >= 0 ? items[active] : undefined;
      if (!it && !needle) return;
      e.preventDefault();
      add(it ? it.name : text);
    } else if (e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      setHl((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      setHl(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setFocused(false);
    }
  }

  return (
    <div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: клавиатура попадает прямо в поле внутри */}
      <div
        ref={box}
        onClick={() => input.current?.focus()}
        className={cn(
          'well field flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1 text-sm transition-colors',
          'focus-within:border-accent',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {value.map((n) => (
          <TagChip
            key={n}
            name={n}
            color={color(n)}
            disabled={disabled}
            onRemove={() => onChange(value.filter((x) => x !== n))}
          />
        ))}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          value={text}
          disabled={disabled}
          maxLength={TAG_MAX}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            const parts = e.target.value.split(',');
            const rest = parts.pop() ?? '';
            if (parts.length) add(...parts);
            setText(rest);
            setHl(rest.trim() ? 0 : -1);
          }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (needle) add(text);
          }}
          className="h-7 min-w-[96px] flex-1 bg-transparent px-1 text-text outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>
      {shown &&
        createPortal(
          // фокус остаётся в поле ввода (aria-activedescendant), список только показывает пункты
          // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: фокус - в поле ввода, select не умеет подсказки по вводу
          <div
            role="listbox"
            ref={list}
            id={listId}
            inert={closing}
            className={cn(
              'glass-strong fixed z-50 flex max-h-60 flex-col overflow-y-auto rounded-xl border p-1 shadow-xl',
              closing ? 'pointer-events-none animate-pop-out' : 'animate-pop-in',
              !pos && 'invisible',
            )}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: pos?.width,
              transformOrigin: pos?.up ? 'bottom center' : 'top center',
            }}
          >
            {view.map((it, i) => (
              // biome-ignore lint/a11y/useSemanticElements lint/a11y/useKeyWithClickEvents: пункт подсказки; клавиатура - стрелки и Enter в поле ввода
              <div
                role="option"
                key={`${it.fresh ? '+' : ''}${it.name}`}
                id={`${listId}-${i}`}
                aria-selected={i === active}
                tabIndex={-1}
                // фокус остаётся в поле: без этого blur добавил бы набранный текст раньше выбора
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(it.name)}
                onMouseEnter={() => setHl(i)}
                className={cn(
                  'flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors',
                  i === active ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                {it.fresh ? (
                  <>
                    <Plus className="size-3.5 shrink-0 text-muted" />
                    <span className="text-muted">Новый тег</span>
                    <TagChip
                      name={it.name}
                      color={tagColorOf(tags, [...value, it.name])(it.name)}
                    />
                  </>
                ) : (
                  <TagChip name={it.name} color={color(it.name)} />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
