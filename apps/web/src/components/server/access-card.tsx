import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LinkButton } from '@/components/ui/link-button';
import { Section } from '@/components/ui/section';
import { SortableList } from '@/components/ui/sortable';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useCopy } from '@/lib/use-copy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface AccessField {
  label: string;
  value: string;
  secret?: boolean;
}
interface AccessEntry {
  id: string;
  kind: string;
  title: string;
  fields: AccessField[];
  note: string;
}

const accessApi = {
  list: (sid: string) => api<AccessEntry[]>(`/api/servers/${sid}/access`),
  create: (sid: string, body: Omit<AccessEntry, 'id'>) =>
    api<AccessEntry>(`/api/servers/${sid}/access`, { method: 'POST', json: body }),
  update: (sid: string, id: string, body: Omit<AccessEntry, 'id'>) =>
    api<AccessEntry>(`/api/servers/${sid}/access/${id}`, { method: 'PATCH', json: body }),
  remove: (sid: string, id: string) =>
    api<{ ok: boolean }>(`/api/servers/${sid}/access/${id}`, { method: 'DELETE' }),
  order: (sid: string, ids: string[]) =>
    api<{ ok: boolean }>(`/api/servers/${sid}/access/order`, { method: 'PUT', json: { ids } }),
};

/** Значение поля: секреты скрыты точками, кнопки показать и скопировать. */
function FieldValue({ f }: { f: AccessField }) {
  const [shown, setShown] = useState(false);
  const { copied, copy: copyText } = useCopy();
  const isLink = /^(https?:\/\/|tg:\/\/)/.test(f.value);
  const copy = () => copyText(f.value);
  if (isLink && !f.secret) return <LinkButton href={f.value}>Открыть</LinkButton>;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {f.secret && !shown ? (
        <span className="font-mono tracking-wider text-muted">{'\u2022'.repeat(8)}</span>
      ) : isLink ? (
        <a
          href={f.value}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-accent hover:underline"
          title={f.value}
        >
          {f.value}
        </a>
      ) : (
        <span className="truncate font-mono" title={f.value}>
          {f.value}
        </span>
      )}
      {f.secret && (
        <Button
          size="icon-sm"
          variant="ghost"
          title={shown ? 'Скрыть' : 'Показать'}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" title="Скопировать" onClick={copy}>
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}

/** Блок "Доступы": логины, пароли и ссылки к панелям сервера; команды установки пишут их сами. */
export function AccessCard({ serverId }: { serverId: string }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['access', serverId],
    queryFn: () => accessApi.list(serverId),
  });
  const [edit, setEdit] = useState<AccessEntry | 'new' | null>(null);
  const op = useAction();

  async function remove(e: AccessEntry) {
    if (
      !(await ask({
        title: `Удалить доступ \u00ab${e.title}\u00bb?`,
        okLabel: 'Удалить',
        danger: true,
      }))
    )
      return;
    await op.run(async () => {
      await accessApi.remove(serverId, e.id);
      await qc.invalidateQueries({ queryKey: ['access', serverId] });
    });
  }

  // порядок после перетаскивания: держим локально, пока не придёт список с сервера,
  // иначе кэш react-query обновится на следующем тике и строки прыгнут
  const [moved, setMoved] = useState<{ base: AccessEntry[] | undefined; items: AccessEntry[] }>();
  async function reorder(next: AccessEntry[]) {
    setMoved({ base: data, items: next });
    const ok = await op.run(() =>
      accessApi.order(
        serverId,
        next.map((e) => e.id),
      ),
    );
    if (!ok) setMoved(undefined);
    await qc.invalidateQueries({ queryKey: ['access', serverId] });
  }

  const list = (moved && moved.base === data ? moved.items : data) ?? [];
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound className="size-4 text-muted" />
          Доступы
        </span>
      }
      actions={
        <Button size="sm" onClick={() => setEdit('new')} label="Добавить">
          <Plus className="size-3.5" />
        </Button>
      }
    >
      {op.error && (
        <div className="px-4 pt-3">
          <Alert tone="bad">{op.error}</Alert>
        </div>
      )}
      {list.length === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">
          Доступов нет. Команды установки 3X-UI, MTProxy и WDTT добавляют их сами.
        </div>
      )}
      <div className="divide-y divide-border">
        <SortableList items={list} getId={(e) => e.id} onReorder={reorder}>
          {(e, handle) => (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2">
                {handle}
                <div className="font-medium">{e.title}</div>
                <div className="grow" />
                <Button size="sm" variant="ghost" title="Изменить" onClick={() => setEdit(e)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" title="Удалить" onClick={() => remove(e)}>
                  <Trash2 className="size-3.5 text-bad" />
                </Button>
              </div>
              <div className="mt-1.5 grid grid-cols-[minmax(90px,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]">
                {e.fields.map((f, i) => (
                  <div key={`${f.label}-${i}`} className="contents">
                    <span className="text-xs text-muted">{f.label}</span>
                    <FieldValue f={f} />
                  </div>
                ))}
              </div>
              {e.note && <div className="mt-1.5 text-xs text-muted">{e.note}</div>}
            </div>
          )}
        </SortableList>
      </div>
      <AccessDialog
        serverId={serverId}
        entry={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          void qc.invalidateQueries({ queryKey: ['access', serverId] });
        }}
      />
    </Section>
  );
}

/** Поле в форме: key - локальный id строки для перетаскивания, в API не уходит. */
type FieldRow = AccessField & { key: number };
let nextKey = 0;
const row = (f: AccessField): FieldRow => ({ ...f, key: nextKey++ });

function AccessDialog({
  serverId,
  entry,
  onClose,
  onSaved,
}: {
  serverId: string;
  entry: AccessEntry | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([]);
  const op = useAction();
  const [initFor, setInitFor] = useState<string | null>(null);
  const key = entry === null ? null : entry === 'new' ? 'new' : entry.id;
  if (key !== null && initFor !== key) {
    setInitFor(key);
    if (entry === 'new') {
      setTitle('');
      setNote('');
      setFields([
        row({ label: 'Адрес', value: '' }),
        row({ label: 'Логин', value: '' }),
        row({ label: 'Пароль', value: '', secret: true }),
      ]);
    } else if (entry) {
      setTitle(entry.title);
      setNote(entry.note);
      setFields(entry.fields.map(row));
    }
    op.setError(null);
  }
  if (key === null && initFor !== null) setInitFor(null);

  const setField = (key: number, patch: Partial<AccessField>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await op.run(async () => {
      const body = {
        kind: entry !== 'new' && entry ? entry.kind : 'custom',
        title: title.trim(),
        note: note.trim(),
        fields: fields
          .filter((f) => f.label.trim() && f.value.trim())
          .map((f) => ({
            label: f.label.trim(),
            value: f.value.trim(),
            secret: Boolean(f.secret),
          })),
      };
      if (entry === 'new') await accessApi.create(serverId, body);
      else if (entry) await accessApi.update(serverId, entry.id, body);
      onSaved();
    });
  }

  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      title={entry === 'new' ? 'Новый доступ' : 'Изменить доступ'}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Название" htmlFor="acc-title">
          <Input
            id="acc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Панель 3X-UI"
            required
          />
        </Field>
        <div className="flex flex-col gap-2">
          <Label>Поля</Label>
          <SortableList items={fields} getId={(f) => String(f.key)} onReorder={setFields}>
            {(f, handle) => (
              // на телефоне строка переносится: "секрет" и корзина уходят под значение
              <div className="flex flex-wrap items-center gap-2">
                {handle}
                <Input
                  value={f.label}
                  onChange={(e) => setField(f.key, { label: e.target.value })}
                  placeholder="Логин"
                  className="w-[120px] shrink-0"
                />
                <Input
                  value={f.value}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  onChange={(e) => setField(f.key, { value: e.target.value })}
                  placeholder="значение"
                  className="min-w-0 grow basis-40 font-mono"
                />
                <Checkbox
                  className="shrink-0 text-xs"
                  title="Скрывать значение"
                  label="секрет"
                  checked={Boolean(f.secret)}
                  onChange={(e) => setField(f.key, { secret: e.target.checked })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  title="Убрать поле"
                  onClick={() => setFields((fs) => fs.filter((x) => x.key !== f.key))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </SortableList>
          <div>
            <Button
              size="sm"
              onClick={() => setFields((fs) => [...fs, row({ label: '', value: '' })])}
              label="Добавить поле"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>
        <Field label="Заметка" htmlFor="acc-note">
          <Textarea id="acc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {op.error && <Alert tone="bad">{op.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={op.busy || !title.trim()}>
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
