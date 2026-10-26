import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
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
import { Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

const tagUrl = (name: string) => `/api/tags?name=${encodeURIComponent(name)}`;

const usage = (n: number) =>
  n ? `${n} ${plural(n, 'сервер', 'сервера', 'серверов')}` : 'не используется';

/**
 * Справочник тегов серверов: теги строкой, у каждого карандаш - окно правки (имя, цвет,
 * удаление). Имя другого тега - слияние с ним.
 */
export function TagsSettings() {
  const { data, isFetching } = useTags();
  const [edit, setEdit] = useState<Tag | null>(null);

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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          {data.map((t, i) => (
            <span
              key={t.name}
              style={{ '--i': i } as React.CSSProperties}
              className="stagger inline-flex animate-rise items-center"
              title={usage(t.servers)}
            >
              <TagChip name={t.name} color={t.color} />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Изменить тег ${t.name}`}
                title="Изменить"
                disabled={isFetching}
                onClick={() => setEdit(t)}
              >
                <Pencil className="size-3.5" />
              </Button>
            </span>
          ))}
        </div>
      )}
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title="Тег сервера">
        {edit && <TagForm tag={edit} tags={data ?? []} onDone={() => setEdit(null)} />}
      </Dialog>
    </Section>
  );
}

/** Правка тега: имя и цвет сохраняются вместе; удаление снимает тег со всех серверов. */
function TagForm({ tag, tags, onDone }: { tag: Tag; tags: Tag[]; onDone: () => void }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const op = useAction();
  const [value, setValue] = useState(tag.name);
  const [color, setColor] = useState<TagColor>(tag.color);

  const reload = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tags'] }),
      qc.invalidateQueries({ queryKey: ['servers'] }),
    ]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const name = value.trim();
    const other = tags.find(
      (t) => t.name !== tag.name && t.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'),
    );
    if (
      other &&
      !(await ask({
        title: `Объединить с тегом \u00ab${other.name}\u00bb?`,
        text: `Тег \u00ab${tag.name}\u00bb исчезнет, на его серверах встанет \u00ab${other.name}\u00bb`,
        okLabel: 'Объединить',
      }))
    )
      return;
    const body: { name?: string; color?: TagColor } = {};
    if (name !== tag.name) body.name = name;
    if (!other && color !== tag.color) body.color = color;
    if (!body.name && !body.color) {
      onDone();
      return;
    }
    const done = await op.run(async () => {
      await api(tagUrl(tag.name), { method: 'PATCH', json: body });
      await reload();
    });
    if (done) onDone();
  }

  async function remove() {
    const ok = await ask({
      title: `Удалить тег \u00ab${tag.name}\u00bb?`,
      text: tag.servers
        ? `Тег снимется с ${tag.servers} ${plural(tag.servers, 'сервера', 'серверов', 'серверов')}`
        : undefined,
      okLabel: 'Удалить',
      danger: tag.servers > 0,
    });
    if (!ok) return;
    const done = await op.run(async () => {
      await api(tagUrl(tag.name), { method: 'DELETE' });
      await reload();
    });
    if (done) onDone();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="Имя" htmlFor="tag-name" hint={`сейчас: ${usage(tag.servers)}`}>
        <Input
          id="tag-name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={TAG_MAX}
          autoFocus
          disabled={op.busy}
        />
      </Field>
      <Field
        label={
          <span className="flex items-center gap-2">
            Цвет <TagChip name={value.trim() || tag.name} color={color} />
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-1">
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={color === c}
              aria-label={TAG_COLOR_NAME[c]}
              title={TAG_COLOR_NAME[c]}
              disabled={op.busy}
              onClick={() => setColor(c)}
              className="flex size-8 items-center justify-center rounded-full transition-transform duration-150 not-disabled:hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className={cn(
                  'size-5 rounded-full',
                  TAG_SWATCH[c],
                  color === c && 'ring-2 ring-offset-2 ring-offset-bg',
                )}
              />
            </button>
          ))}
        </div>
      </Field>
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex items-center gap-2">
        <Button variant="danger" disabled={op.busy} onClick={() => void remove()}>
          <Trash2 className="size-3.5" />
          Удалить
        </Button>
        <div className="grow" />
        <Button variant="ghost" disabled={op.busy} onClick={onDone}>
          Отмена
        </Button>
        <Button type="submit" variant="primary" disabled={op.busy || !value.trim()}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}
