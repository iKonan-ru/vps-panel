import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LinkButton } from '@/components/ui/link-button';
import { Pager, usePaged } from '@/components/ui/pager';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { List, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface OfDoc {
  id: string;
  kind: 'vyandex' | 'mailru';
  url: string;
  usedBy: { client: string; device: string; server: string } | null;
}

const kindTitle = { vyandex: 'Яндекс', mailru: 'Mail.ru' };

/** Пул документов OpenFlux: каждый канал клиента берёт свободный документ Яндекса и Mail.ru. */
export function OpenfluxDocsSettings() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data } = useQuery({
    queryKey: ['openflux-docs'],
    queryFn: () => api<OfDoc[]>('/api/openflux/docs'),
  });
  const [text, setText] = useState('');
  const op = useAction();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;
  const [showForm, setShowForm] = useState(false);
  const [showList, setShowList] = useState(false);
  const [kind, setKind] = useState<'all' | OfDoc['kind']>('all');
  const [state, setState] = useState<'all' | 'used' | 'free'>('all');
  const [q, setQ] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['openflux-docs'] });

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    await op.run(async () => {
      const r = await api<{ added: number; bad: string[] }>('/api/openflux/docs', {
        method: 'POST',
        json: { text },
      });
      await refresh();
      setText(r.bad.join('\n'));
      setMsg(
        r.bad.length
          ? {
              tone: 'bad',
              text: `Добавлено: ${r.added}. Не подошли: ${r.bad.length}\u00a0\u2014 нужны ссылки docs.yandex.ru/edit/d/\u2026 или cloud.mail.ru/public/\u2026`,
            }
          : {
              tone: 'ok',
              text: `Добавлено: ${r.added}`,
            },
      );
    });
  }

  const docs = data ?? [];
  const count = (k: OfDoc['kind']) => {
    const all = docs.filter((d) => d.kind === k);
    return { all: all.length, free: all.filter((d) => !d.usedBy).length };
  };
  const ya = count('vyandex');
  const mr = count('mailru');
  // пустой пул - сразу форма; иначе форма и список по кнопкам: 100+ строк не занимают страницу
  const formShown = showForm || (data !== undefined && docs.length === 0);
  const needle = q.trim().toLowerCase();
  const rows = docs.filter(
    (d) =>
      (kind === 'all' || d.kind === kind) &&
      (state === 'all' || (state === 'used') === Boolean(d.usedBy)) &&
      (!needle ||
        (d.usedBy &&
          `${d.usedBy.client} ${d.usedBy.device} ${d.usedBy.server}`
            .toLowerCase()
            .includes(needle))),
  );
  const paged = usePaged(rows, 10);

  async function remove(d: OfDoc) {
    const ok = await ask({
      title: 'Удалить документ из пула?',
      text: d.usedBy
        ? `У клиента ${d.usedBy.client} на ${d.usedBy.server} сменится ссылка.`
        : undefined,
      okLabel: 'Удалить',
      danger: Boolean(d.usedBy),
    });
    if (!ok) return;
    await op.run(async () => {
      await api(`/api/openflux/docs/${d.id}`, { method: 'DELETE' });
      await refresh();
    });
  }

  return (
    <Section
      title="OpenFlux: документы"
      info={
        'Запасной транспорт каналов клиентов: Яндекс Документ или документ Облака Mail.ru с доступом на редактирование по ссылке. Один документ\u00a0\u2014 один канал. Без свободных документов канал работает без них'
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]">
        {data === undefined ? (
          <span className="text-muted">Загрузка&hellip;</span>
        ) : (
          <>
            {(
              [
                ['Яндекс', ya],
                ['Mail.ru', mr],
              ] as const
            ).map(([t, n]) => {
              return (
                <span key={t} className="flex items-center gap-1.5">
                  <span className="text-muted">{t}:</span>
                  <Chip>занято {n.all - n.free}</Chip>
                  <Chip tone={n.free ? 'ok' : n.all ? 'warn' : 'muted'}>свободно {n.free}</Chip>
                </span>
              );
            })}
            <div className="grow" />
            {docs.length > 0 && (
              <Button
                size="sm"
                variant={showList ? 'primary' : 'default'}
                onClick={() => setShowList(!showList)}
              >
                <List className="size-3.5" />
                Список ({docs.length})
              </Button>
            )}
            {docs.length > 0 && (
              <Button
                size="sm"
                variant={showForm ? 'primary' : 'default'}
                onClick={() => setShowForm(!showForm)}
              >
                <Plus className="size-3.5" />
                Добавить
              </Button>
            )}
          </>
        )}
      </div>
      {formShown && (
        <form className="flex flex-col gap-3 border-t border-border p-4" onSubmit={add}>
          <Field label="Ссылки на документы, по одной в строке" htmlFor="of-docs">
            <Textarea
              id="of-docs"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                'https://docs.yandex.ru/edit/d/...\nhttps://cloud.mail.ru/public/.../...'
              }
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={op.busy || !text.trim()}>
              Добавить
            </Button>
          </div>
        </form>
      )}
      {note && (
        <div className="border-t border-border p-4">
          <Alert tone={note.tone}>{note.text}</Alert>
        </div>
      )}
      {showList && docs.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
            <Select
              size="sm"
              aria-label="Вид"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="all">все виды</option>
              <option value="vyandex">Яндекс</option>
              <option value="mailru">Mail.ru</option>
            </Select>
            <Select
              size="sm"
              aria-label="Состояние"
              value={state}
              onChange={(e) => setState(e.target.value as typeof state)}
            >
              <option value="all">все</option>
              <option value="used">занятые</option>
              <option value="free">свободные</option>
            </Select>
            <Input
              type="search"
              aria-label="Поиск"
              placeholder="Клиент, устройство, сервер"
              className="h-7 w-[220px] grow text-xs sm:grow-0"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {paged.items.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-[13px]"
            >
              <Chip>{kindTitle[d.kind]}</Chip>
              <span className="min-w-0 grow truncate">
                {d.usedBy ? (
                  <>
                    {d.usedBy.client}
                    {d.usedBy.device && <span className="text-muted"> ({d.usedBy.device})</span>}
                    <span className="text-muted">, {d.usedBy.server}</span>
                  </>
                ) : (
                  <span className="text-muted">свободен</span>
                )}
              </span>
              <LinkButton
                href={d.url}
                label="Документ"
                title="Открыть документ"
                copyTitle="Скопировать ссылку на документ"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                title="Удалить из пула"
                onClick={() => remove(d)}
              >
                <Trash2 className="size-3.5 text-bad" />
              </Button>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="border-t border-border px-4 py-3 text-[13px] text-muted">
              Ничего не найдено
            </div>
          )}
          <Pager {...paged} />
        </>
      )}
    </Section>
  );
}
