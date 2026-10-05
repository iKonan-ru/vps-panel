import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

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
 * Ключи root (/root/.ssh/authorized_keys) через агента: список с удалением и правкой
 * комментария, ниже - добавление ключа панели (чтобы панель могла переустанавливать агента)
 * и своих ключей. Ключи нужны до исправления SSH: оно отключает вход по паролю.
 */
export function SshKeysDialog({
  serverId,
  open,
  onClose,
}: { serverId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [own, setOwn] = useState('');
  const [panel, setPanel] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const key = useQuery({
    queryKey: ['panel-ssh-key'],
    queryFn: () => api<{ publicKey: string }>('/api/panel/ssh-key'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const list = useQuery({
    queryKey: ['ssh-keys', serverId],
    queryFn: () =>
      api<{ keys: SshKey[]; passwordLogin: boolean }>(`/api/servers/${serverId}/ssh-keys`),
    enabled: open,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ssh-keys', serverId] });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const keys = own
        .split('\n')
        .map((k) => k.trim())
        .filter(Boolean);
      const r = await actions.sshKeysAdd(serverId, keys, panel);
      setResult(r.added);
      setOwn('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Ключи root" wide>
      <div className="flex items-center gap-1 text-[13px] text-muted">
        Ключи из /root/.ssh/authorized_keys.
        <InfoTip>
          Эталон отключает вход по паролю, поэтому у root должен быть хотя бы один ключ. Перед
          каждым изменением прежний файл сохраняется в authorized_keys.vps-panel.bak.
        </InfoTip>
      </div>
      <KeyList serverId={serverId} query={list} onChanged={refresh} />
      <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4">
        <div className="font-medium">Добавить</div>
        <Checkbox
          checked={panel}
          onChange={(e) => setPanel(e.target.checked)}
          label="Ключ панели - чтобы панель могла переустанавливать агента без пароля"
          hint={
            key.data ? <span className="break-all font-mono">{key.data.publicKey}</span> : undefined
          }
        />
        <Field
          label="Свои публичные ключи (по одному в строке, содержимое ~/.ssh/id_ed25519.pub)"
          htmlFor="own-keys"
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
        {error && <Alert tone="bad">{error}</Alert>}
        {result !== null && (
          <Alert tone="ok">
            Добавлено ключей: {result}. Проверь вход по ключу до отключения паролей.
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Закрыть</Button>
          <Button type="submit" variant="primary" disabled={busy || (!panel && !own.trim())}>
            Добавить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Список ключей: тип, комментарий, отпечаток; правка комментария и удаление. */
function KeyList({
  serverId,
  query,
  onChanged,
}: {
  serverId: string;
  query: {
    data?: { keys: SshKey[]; passwordLogin: boolean } | undefined;
    error: Error | null;
    isLoading: boolean;
  };
  onChanged: () => Promise<void>;
}) {
  const ask = useConfirm();
  const [edit, setEdit] = useState<{ fp: string; comment: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function op(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(k: SshKey) {
    const ok = await ask({
      title: `Удалить ключ ${k.comment || keyType(k.type)}?`,
      text: k.panel
        ? 'Это ключ панели: без него панель не сможет заходить на сервер по SSH (переустановка агента - только с паролем root).'
        : 'Вход по этому ключу перестанет работать.',
      okLabel: 'Удалить',
      danger: true,
    });
    if (ok) await op(() => actions.sshKeysRemove(serverId, k.fingerprint));
  }

  if (query.isLoading) return <div className="text-sm text-muted">Читаю ключи...</div>;
  if (query.error) return <Alert tone="bad">{query.error.message}</Alert>;
  const data = query.data;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-2">
      {data.keys.length === 0 && <div className="text-sm text-muted">Ключей у root нет.</div>}
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
                if (await op(() => actions.sshKeysComment(serverId, k.fingerprint, edit.comment)))
                  setEdit(null);
              }}
            >
              <Input
                value={edit.comment}
                onChange={(e) => setEdit({ ...edit, comment: e.target.value })}
                maxLength={200}
                autoFocus
                aria-label="Комментарий ключа"
                placeholder="например, ноутбук"
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
            {/* плашка не в строке с комментарием: на мобиле она съедала его до "vp..." */}
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
          ? 'Root может войти по паролю.'
          : 'Вход root по паролю выключен: последний ключ удалить нельзя.'}
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
    </div>
  );
}
