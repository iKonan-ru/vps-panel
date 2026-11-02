import { ActionOutput } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useCopy } from '@/lib/use-copy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ServerDetail, UninstallPlan } from '@vps/protocol';
import { useState } from 'react';

/** Состав очистки и проверка нового пароля root до удаления сервисов и агента. */
export function FullCleanupDialog({ s, onClose }: { s: ServerDetail; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [peerPasswords, setPeerPasswords] = useState<
    Record<string, { password: string; repeat: string }>
  >({});
  const [actionId, setActionId] = useState<string | null>(null);
  const [finished, setFinished] = useState<number | null>(null);
  const start = useAction();
  const copy = useCopy();
  const plan = useQuery({
    queryKey: ['uninstall', s.id],
    queryFn: () => api<UninstallPlan>(`/api/servers/${s.id}/uninstall`),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const data = plan.data;
  const ids = data?.items.filter((i) => i.owned || selected.includes(i.id)).map((i) => i.id) ?? [];
  const blockers = [
    ...(data?.blockers ?? []),
    ...(data?.connections?.blockers ?? []),
    ...(data?.items.filter((i) => ids.includes(i.id)).flatMap((i) => i.blockers) ?? []),
  ];
  const busy = start.busy || (actionId !== null && finished === null);
  const self = s.panelHost || data?.panelHost;
  const disabled = busy || plan.isFetching;

  async function run() {
    if (!data || disabled) return;
    await start.run(async () => {
      const result = await api<{ actionId: string }>(`/api/servers/${s.id}/uninstall`, {
        method: 'POST',
        json: {
          confirmName: name,
          revision: data.revision,
          connectionsRevision: data.connections?.revision,
          ids,
          password,
        },
      });
      setActionId(result.actionId);
      setFinished(null);
      setPassword('');
      setRepeat('');
    });
  }

  async function detach() {
    if (!data?.connections || disabled) return;
    await start.run(async () => {
      const result = await api<{ actionId: string }>(`/api/servers/${s.id}/uninstall/connections`, {
        method: 'POST',
        json: {
          confirmName: name,
          connectionsRevision: data.connections?.revision,
          servers: (data.detachServers ?? []).map((peer) => ({
            ...peer,
            password: peerPasswords[peer.id]?.password ?? '',
          })),
        },
      });
      setActionId(result.actionId);
      setFinished(null);
      setPeerPasswords({});
    });
  }

  function complete(code: number) {
    setFinished(code);
    if (self) void plan.refetch();
  }

  async function close() {
    if (busy) return;
    if (finished === 0 && !self) {
      await nav({ to: '/' });
      qc.removeQueries({ queryKey: ['servers', s.id] });
      void qc.invalidateQueries({ queryKey: ['servers'], exact: true });
    }
    onClose();
  }

  return (
    <Dialog
      open
      title={`Полная очистка \u00ab${s.name}\u00bb`}
      onClose={() => {
        if (!disabled) void close();
      }}
      wide
    >
      {data?.connections && data.connections.items.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-bad/30 p-3">
          <p className="font-medium">Связи, которые будут сняты до удаления</p>
          {data.connections.items.map((item) => (
            <div key={item.id} className="text-sm">
              <p>{item.title}</p>
              <p className="text-muted">{item.consequence}</p>
            </div>
          ))}
          <p className="text-sm text-muted">
            Если связанный сервер недоступен или снятие связи не удалось, очистка остановится. Уже
            снятые связи автоматически не восстанавливаются.
          </p>
        </div>
      )}
      {self ? (
        <>
          <Alert>
            Сервер панели очищается по SSH. Команда покажет состав, запросит новый пароль root и
            проверит вход перед удалением.
          </Alert>
          <code className="text-sm">vps-panel uninstall --full</code>
          <Button disabled={disabled} onClick={() => copy.copy('vps-panel uninstall --full')}>
            {copy.copied ? 'Скопировано' : 'Скопировать команду'}
          </Button>
          {plan.isFetching && <p className="text-sm text-muted">Проверка связей&hellip;</p>}
          {plan.error && <Alert tone="bad">{plan.error.message}</Alert>}
          {data?.connections?.blockers.map((b) => (
            <Alert key={b} tone="bad">
              {b}
            </Alert>
          ))}
          {(data?.detachServers ?? []).map((peer) => (
            <div key={peer.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <p className="font-medium">{peer.name}: доступ после отвязки</p>
              <Field
                label="Новый пароль root"
                htmlFor={`detach-password-${peer.id}`}
                hint="От 12 символов. Перед снятием агента будет проверен отдельный SSH-вход."
              >
                <Input
                  id={`detach-password-${peer.id}`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={200}
                  disabled={disabled}
                  value={peerPasswords[peer.id]?.password ?? ''}
                  onChange={(e) =>
                    setPeerPasswords((old) => ({
                      ...old,
                      [peer.id]: { password: e.target.value, repeat: old[peer.id]?.repeat ?? '' },
                    }))
                  }
                />
              </Field>
              <Field label="Повторить пароль" htmlFor={`detach-repeat-${peer.id}`}>
                <Input
                  id={`detach-repeat-${peer.id}`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={200}
                  disabled={disabled}
                  value={peerPasswords[peer.id]?.repeat ?? ''}
                  onChange={(e) =>
                    setPeerPasswords((old) => ({
                      ...old,
                      [peer.id]: { repeat: e.target.value, password: old[peer.id]?.password ?? '' },
                    }))
                  }
                />
              </Field>
            </div>
          ))}
          {data?.connections && (
            <>
              <Field label={`Имя сервера для подтверждения: ${s.name}`} htmlFor="full-cleanup-name">
                <Input
                  id="full-cleanup-name"
                  value={name}
                  disabled={disabled}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button
                variant="danger"
                disabled={
                  disabled ||
                  name !== s.name ||
                  data.connections.blockers.length > 0 ||
                  (data.detachServers ?? []).some(
                    (peer) =>
                      (peerPasswords[peer.id]?.password.length ?? 0) < 12 ||
                      peerPasswords[peer.id]?.password !== peerPasswords[peer.id]?.repeat,
                  )
                }
                onClick={() => void detach()}
              >
                Снять связи
              </Button>
            </>
          )}
          {start.error && <Alert tone="bad">{start.error}</Alert>}
          {actionId && <ActionOutput actionId={actionId} onFinished={complete} />}
          <Button disabled={disabled} onClick={() => void plan.refetch()}>
            Проверить заново
          </Button>
        </>
      ) : (
        <>
          <Alert>
            Выбранные сервисы, их пользователи, ключи и данные будут удалены без возможности
            восстановления. После успешной очистки сервер исчезнет из панели.
          </Alert>
          {plan.isFetching && (
            <p className="text-sm text-muted">Проверка состава сервера&hellip;</p>
          )}
          {plan.error && <Alert tone="bad">{plan.error.message}</Alert>}
          {data && (
            <>
              <div className="flex flex-col gap-3">
                {data.items.map((item) => (
                  <Checkbox
                    key={item.id}
                    label={item.title}
                    hint={
                      item.owned
                        ? 'Ресурс панели'
                        : 'Происхождение неизвестно. Выбрать только если ресурс больше не нужен.'
                    }
                    checked={ids.includes(item.id)}
                    disabled={disabled || item.owned || finished === 0}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, item.id] : old.filter((x) => x !== item.id),
                      )
                    }
                  />
                ))}
              </div>
              <details className="text-sm text-muted">
                <summary className="cursor-pointer">Пути и сохраняемые ресурсы</summary>
                <ul className="mt-2 list-inside list-disc break-words">
                  {data.items
                    .filter((i) => ids.includes(i.id))
                    .flatMap((i) => i.paths)
                    .map((p) => (
                      <li key={p} className="font-mono text-xs">
                        {p}
                      </li>
                    ))}
                </ul>
                <ul className="mt-3 list-inside list-disc">
                  {data.preserved.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  Docker сохраняется при наличии сторонних ресурсов или неизвестном происхождении
                  установки.
                </p>
              </details>
            </>
          )}
          {blockers.map((b) => (
            <Alert key={b} tone="bad">
              {b}
            </Alert>
          ))}
          {finished !== 0 && (
            <>
              <Field
                label="Новый пароль root"
                htmlFor="full-cleanup-password"
                hint="От 12 символов. Перед удалением панель проверит отдельный SSH-вход. Пароль не сохраняется в панели."
              >
                <Input
                  id="full-cleanup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Повторить пароль" htmlFor="full-cleanup-repeat">
                <Input
                  id="full-cleanup-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </Field>
              <Field label={`Имя сервера для подтверждения: ${s.name}`} htmlFor="full-cleanup-name">
                <Input
                  id="full-cleanup-name"
                  autoComplete="off"
                  value={name}
                  disabled={disabled}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </>
          )}
          {start.error && <Alert tone="bad">{start.error}</Alert>}
          {actionId && <ActionOutput actionId={actionId} onFinished={complete} />}
          {finished === 0 && (
            <Alert tone="ok">Очистка завершена. Вход root по новому паролю сохранён.</Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={disabled || finished === 0}
              onClick={() => {
                setSelected([]);
                void plan.refetch();
              }}
            >
              Проверить заново
            </Button>
            <Button disabled={disabled} onClick={() => void close()}>
              {finished === 0 ? 'К списку серверов' : 'Закрыть'}
            </Button>
            {finished !== 0 && (
              <Button
                variant="danger"
                disabled={
                  disabled ||
                  !data ||
                  !data.connections ||
                  Boolean(plan.error) ||
                  blockers.length > 0 ||
                  name !== s.name ||
                  password.length < 12 ||
                  password !== repeat
                }
                onClick={() => void run()}
              >
                Очистить сервер
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
