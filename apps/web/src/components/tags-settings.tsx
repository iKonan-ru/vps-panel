import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { TagChip } from '@/components/ui/tag-chip';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { TAG_COLOR_NAME, TAG_SWATCH, useTags } from '@/lib/tags';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { TAG_COLORS, TAG_MAX, type Tag, type TagColor } from '@vps/protocol';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

const tagUrl = (name: string) => `/api/tags?name=${encodeURIComponent(name)}`;

/** Справочник тегов серверов: цвет, новое имя (имя другого тега - слияние), удаление. */
export function TagsSettings() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data, isFetching } = useTags();
  const op = useAction();
  const [edit, setEdit] = useState<{ name: string; value: string } | null>(null);
  // пока идёт своё действие или список перечитывается - действия раздела недоступны
  const locked = op.busy || isFetching;

  const reload = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tags'] }),
      qc.invalidateQueries({ queryKey: ['servers'] }),
    ]);

  async function patch(name: string, body: { name?: string; color?: TagColor }) {
    return op.run(async () => {
      await api(tagUrl(name), { method: 'PATCH', json: body });
      await reload();
    });
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const value = edit.value.trim();
    const other = data?.find(
      (t) =>
        t.name !== edit.name && t.name.toLocaleLowerCase('ru') === value.toLocaleLowerCase('ru'),
    );
    if (
      other &&
      !(await ask({
        title: `Объединить с тегом \u00ab${other.name}\u00bb?`,
        text: `Тег \u00ab${edit.name}\u00bb исчезнет, на его серверах встанет \u00ab${other.name}\u00bb`,
        okLabel: 'Объединить',
      }))
    )
      return;
    if (await patch(edit.name, { name: value })) setEdit(null);
  }

  async function remove(t: Tag) {
    const ok = await ask({
      title: `Удалить тег \u00ab${t.name}\u00bb?`,
      text: t.servers
        ? `Тег снимется с ${t.servers} ${plural(t.servers, 'сервера', 'серверов', 'серверов')}`
        : undefined,
      okLabel: 'Удалить',
      danger: t.servers > 0,
    });
    if (!ok) return;
    await op.run(async () => {
      await api(tagUrl(t.name), { method: 'DELETE' });
      await reload();
    });
  }

  return (
    <Section
      title="Теги серверов"
      info={
        'Теги ставятся у сервера: карандаш рядом с именем или поле при добавлении. Здесь\u00a0\u2014 цвет, имя и удаление со всех серверов'
      }
    >
      {data === undefined ? (
        <div className="px-4 py-3 text-[13px] text-muted">Загрузка&hellip;</div>
      ) : data.length === 0 ? (
        <div className="px-4 py-3 text-[13px] text-muted">Тегов пока нет</div>
      ) : (
        <div className="flex flex-col">
          {data.map((t, i) => (
            <div
              key={t.name}
              style={{ '--i': i } as React.CSSProperties}
              className="stagger flex animate-rise flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              {edit?.name === t.name ? (
                <form onSubmit={rename} className="flex min-w-0 grow items-center gap-2">
                  <Input
                    aria-label="Новое имя тега"
                    value={edit.value}
                    onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                    maxLength={TAG_MAX}
                    autoFocus
                    disabled={op.busy}
                    className="h-7.5 max-w-[240px] text-[13px]"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEdit(null);
                    }}
                  />
                  <Button
                    type="submit"
                    size="icon-sm"
                    variant="primary"
                    aria-label="Сохранить"
                    disabled={locked || !edit.value.trim()}
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Отмена"
                    disabled={op.busy}
                    onClick={() => setEdit(null)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </form>
              ) : (
                <div className="flex min-w-0 grow items-center gap-2.5">
                  <TagChip name={t.name} color={t.color} />
                  <span className="whitespace-nowrap text-xs text-muted">
                    {t.servers
                      ? `${t.servers} ${plural(t.servers, 'сервер', 'сервера', 'серверов')}`
                      : 'не используется'}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={t.color === c}
                    aria-label={TAG_COLOR_NAME[c]}
                    title={TAG_COLOR_NAME[c]}
                    disabled={locked}
                    onClick={() => t.color !== c && void patch(t.name, { color: c })}
                    className="flex size-6 items-center justify-center rounded-full transition-transform duration-150 not-disabled:hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span
                      className={cn(
                        'size-3.5 rounded-full',
                        TAG_SWATCH[c],
                        t.color === c && 'ring-2 ring-offset-2 ring-offset-bg',
                      )}
                    />
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Переименовать"
                  title="Переименовать"
                  disabled={locked || edit?.name === t.name}
                  onClick={() => setEdit({ name: t.name, value: t.name })}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Удалить"
                  title="Удалить"
                  disabled={locked}
                  onClick={() => void remove(t)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {op.error && (
        <div className="p-4 pt-0">
          <Alert tone="bad">{op.error}</Alert>
        </div>
      )}
    </Section>
  );
}
