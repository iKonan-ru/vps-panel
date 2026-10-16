import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Textarea } from '@/components/ui/textarea';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerDetail } from '@vps/protocol';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

interface SshKey {
  type: string;
  fingerprint: string;
  comment: string;
  options?: string;
  /** Ключ панели (panel_ssh_ed25519): по нему панель переустанавливает агента. */
  panel?: boolean;
}

/** "ssh-ed25519" -> "ed25519", "ecdsa-sha2-nistp256" -> "ecdsa", "sk-ssh-ed25519@..." -> "ed25519-sk". */
function keyType(t: string): string {
  if (t.startsWith('sk-')) return `${t.replace(/^sk-(ssh-)?/, '').split(/[-@]/)[0]}-sk`;
  if (t.startsWith('ecdsa-')) return 'ecdsa';
  return t.replace(/^ssh-/, '');
}

/**
 * Ключи root через агента; нужны до исправления SSH - оно отключает вход по паролю. Все правки
 * переписывают один файл: пока идёт одна, кнопки вкладки недоступны.
 */
export function SshKeysTab({ s }: { s: ServerDetail }) {
  const qc = useQueryClient();
  const [own, setOwn] = useState('');
  const [panel, setPanel] = useState(true);
  const [result, setResult] = useState<number | null>(null);
  const op = useAction();
  const online = s.status === 'online';
  const lock = serverLock(s);
  const key = useQuery({
    queryKey: ['panel-ssh-key'],
    queryFn: () => api<{ publicKey: string }>('/api/panel/ssh-key'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const list = useQuery({
    queryKey: ['ssh-keys', s.id],
    queryFn: () => api<{ keys: SshKey[]; passwordLogin: boolean }>(`/api/servers/${s.id}/ssh-keys`),
    enabled: online,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ssh-keys', s.id] });
  // занято: своё изменение, чтение списка или действие на сервере
  const busy = !online || op.busy || list.isFetching || lock.busy;
  const run: Run = (fn) =>
    op.run(async () => {
      await fn();
      await refresh();
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    const keys = own
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean);
    await run(async () => {
      const r = await actions.sshKeysAdd(s.id, keys, panel);
      setResult(r.added);
      setOwn('');
    });
  }

  return (
    <>
      <Section
        title="Ключи root"
        info="Исправление SSH отключает вход по паролю: у root нужен хотя бы один ключ. Прежний файл сохраняется в authorized_keys.vps-panel.bak."
        actions={
          <Button
            size="sm"
            disabled={busy}
            title={lock.reason}
            onClick={() => void refresh()}
            label="Обновить"
          >
            <RefreshCw className={list.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        }
      >
        <div className="p-4">
          {!online ? (
            <div className="text-sm text-muted">Сервер не в сети</div>
          ) : (
            <KeyList serverId={s.id} query={list} busy={busy} run={run} />
          )}
          {op.error && (
            <Alert tone="bad" className="mt-3">
              {op.error}
            </Alert>
          )}
        </div>
      </Section>
      <Section title="Новые ключи">
        <form onSubmit={submit} className="flex flex-col gap-4 p-4">
          <Checkbox
            checked={panel}
            onChange={(e) => setPanel(e.target.checked)}
            label="Ключ панели: переустановка агента без пароля"
            hint={
              key.data ? (
                <span className="break-all font-mono">{key.data.publicKey}</span>
              ) : undefined
            }
          />
          <Field
            label="Свои публичные ключи"
            htmlFor="own-keys"
            hint="по одному в строке, например из ~/.ssh/id_ed25519.pub"
          >
            <Textarea
              id="own-keys"
              value={own}
              onChange={(e) => setOwn(e.target.value)}
              placeholder="ssh-ed25519 AAAA... user@pc"
              className="font-mono text-xs"
              rows={4}
            />
          </Field>
          {result !== null && (
            <Alert tone="ok">
              Добавлено ключей: {result}. Вход по ключу стоит проверить до отключения паролей.
            </Alert>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || (!panel && !own.trim())}
              title={lock.reason}
            >
              Добавить
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}

/** Список ключей: тип, комментарий, отпечаток; правка комментария и удаление. */
function KeyList({
  serverId,
  query,
  busy,
  run,
}: {
  serverId: string;
  query: {
    data?: { keys: SshKey[]; passwordLogin: boolean } | undefined;
    error: Error | null;
    isLoading: boolean;
  };
  busy: boolean;
  run: Run;
}) {
  const ask = useConfirm();
  const [edit, setEdit] = useState<{ fp: string; comment: string } | null>(null);

  async function remove(k: SshKey) {
    const ok = await ask({
      title: `Удалить ключ \u00ab${k.comment || keyType(k.type)}\u00bb?`,
      text: k.panel
        ? 'Без ключа панели переустановка агента возможна только с паролем root'
        : 'Вход по этому ключу перестанет работать',
      okLabel: 'Удалить',
      danger: true,
    });
    if (ok) await run(() => actions.sshKeysRemove(serverId, k.fingerprint));
  }

  if (query.isLoading) return <div className="text-sm text-muted">Загрузка&hellip;</div>;
  if (query.error) return <Alert tone="bad">{query.error.message}</Alert>;
  const data = query.data;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-2">
      {data.keys.length === 0 && <div className="text-sm text-muted">Ключей у root нет</div>}
      {data.keys.map((k) => (
        <div
          key={k.fingerprint}
          className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-2 px-3 py-2"
        >
          {edit?.fp === k.fingerprint ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(() => actions.sshKeysComment(serverId, k.fingerprint, edit.comment)))
                  setEdit(null);
              }}
            >
              <Input
                value={edit.comment}
                onChange={(e) => setEdit({ ...edit, comment: e.target.value })}
                maxLength={200}
                autoFocus
                aria-label="Комментарий ключа"
                placeholder="ноутбук"
                className="min-w-0 basis-full sm:basis-0 sm:grow"
              />
              <Button type="submit" variant="primary" disabled={busy}>
                Сохранить
              </Button>
              <Button onClick={() => setEdit(null)}>Отмена</Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <Chip>{keyType(k.type)}</Chip>
              <span className={k.comment ? 'min-w-0 truncate' : 'min-w-0 truncate text-muted'}>
                {k.comment || 'без комментария'}
              </span>
              <div className="grow" />
              <Button
                size="icon-sm"
                variant="ghost"
                title="Изменить комментарий"
                aria-label="Изменить комментарий"
                disabled={busy}
                onClick={() => setEdit({ fp: k.fingerprint, comment: k.comment })}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Удалить ключ"
                aria-label="Удалить ключ"
                disabled={busy}
                onClick={() => void remove(k)}
              >
                <Trash2 className="size-3.5 text-bad" />
              </Button>
            </div>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* плашка не в строке с комментарием: на узком экране она обрезала бы его */}
            {k.panel && <Chip tone="accent">ключ панели</Chip>}
            <span className="min-w-0 break-all font-mono text-xs text-muted">{k.fingerprint}</span>
          </div>
          {k.options && (
            <div className="break-all font-mono text-xs text-muted">опции: {k.options}</div>
          )}
        </div>
      ))}
      <div className="text-xs text-muted">
        {data.passwordLogin
          ? 'Вход root по паролю включён'
          : 'Вход root по паролю выключен: последний ключ удалить нельзя'}
      </div>
    </div>
  );
}
