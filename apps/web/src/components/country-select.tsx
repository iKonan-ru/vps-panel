import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { COUNTRIES, countryLabel, isCountryCode } from '@/lib/countries';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** Выбор страны с поиском; значение - код ISO, текст вместо кода показывается как есть. */
export function CountrySelect({
  id,
  value,
  onChange,
}: { id?: string; value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle,
    );
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (code: string) => {
    onChange(code);
    setQ('');
    setOpen(false);
  };

  const label = value
    ? isCountryCode(value)
      ? countryLabel(value)
      : `${value} (старое значение)`
    : '';

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={open ? q : label}
          placeholder={open ? 'Финляндия' : 'не указана'}
          onFocus={() => {
            setOpen(true);
            setQ('');
          }}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && open) {
              e.preventDefault();
              const it = items[active];
              if (it) pick(it.code);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="pr-16"
          autoComplete="off"
        />
        <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
          {value && (
            <button
              type="button"
              aria-label="Очистить"
              className="rounded p-0.5 text-muted hover:text-text"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick('')}
            >
              <X className="size-3.5" />
            </button>
          )}
          <ChevronDown className="pointer-events-none size-4 text-muted" aria-hidden="true" />
        </div>
      </div>
      {open && (
        <div
          id={listId}
          className="absolute z-20 mt-1 max-h-[240px] animate-pop-in w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl"
        >
          {items.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">Ничего не найдено</div>
          )}
          {items.map((c, i) => (
            <button
              type="button"
              key={c.code}
              tabIndex={-1}
              aria-pressed={c.code === value}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c.code)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                i === active && 'bg-surface-2',
                c.code === value && 'text-accent',
              )}
            >
              <span className="w-6 text-center">{c.flag}</span>
              <span className="grow">{c.name}</span>
              <span className="font-mono text-xs text-muted">{c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
