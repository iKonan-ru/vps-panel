import { ActionPanel } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClass } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useServers } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Download, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Component {
  id: string;
  title: string;
  paths?: string[];
  containers?: string[];
  sizeBytes: number;
}

interface Backup {
  id: string;
  serverId: string | null;
  serverName: string;
  hostname: string;
  createdAt: string;
  size: number;
  sha256: string;
  manifest: { components?: Component[] };
}

const backupsApi = {
  list: () => api<Backup[]>('/api/backups'),
  components: (serverId: string) => api<Component[]>(`/api/servers/${serverId}/backups/components`),
  create: (serverId: string, components: string[]) =>
    api<{ actionId: string; backupId: string }>(`/api/servers/${serverId}/backups`, {
      method: 'POST',
      json: { components },
    }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/backups/${id}`, { method: 'DELETE' }),
  restore: (id: string, serverId: string, components: string[]) =>
    api<{ actionId: string }>(`/api/backups/${id}/restore`, {
      method: 'POST',
      json: { serverId, components },
    }),
};

/** Вкладка "Бэкапы": создать (с выбором компонентов), список бэкапов этого сервера, восстановление на любой сервер. */
export function BackupsTab({ s }: { s: ServerDetail }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны
  const lock = serverLock(s);
  const canAct = online && !lock.busy;
  const { data: all } = useQuery({
    queryKey: ['backups'],
    queryFn: backupsApi.list,
    refetchInterval: 60_000,
  });
  const mine = (all ?? []).filter((b) => b.serverId === s.id);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; title: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [restore, setRestore] = useState<Backup | null>(null);

  async function remove(b: Backup) {
    const ok = await ask({
      title: `Удалить бэкап от ${new Date(b.createdAt).toLocaleString('ru-RU')}?`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await backupsApi.remove(b.id);
      await qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const components = (b: Backup) =>
    (b.manifest.components ?? []).map((c) => (
      <Chip key={c.id} title={c.title}>
        {c.id}
      </Chip>
    ));
  /** Кнопки бэкапа: в строке таблицы и в карточке на мобиле. */
  const backupActions = (b: Backup) => (
    <>
      <a
        href={`/api/backups/${b.id}/download`}
        download
        className={buttonClass({ size: 'icon-sm', variant: 'ghost' })}
        title="Скачать себе"
        aria-label="Скачать себе"
      >
        <Download className="size-3.5" />
      </a>
      <Button size="sm" onClick={() => setRestore(b)} label="Восстановить на...">
        <ArchiveRestore className="size-3.5" />
      </Button>
      <Button size="sm" variant="ghost" title="Удалить" onClick={() => remove(b)}>
        <Trash2 className="size-3.5 text-bad" />
      </Button>
    </>
  );

  return (
    <>
      {error && <Alert tone="bad">{error}</Alert>}
      {action && (
        <ActionPanel
          title={action.title}
          actionId={action.id}
          onHide={() => setAction(null)}
          onFinished={() => qc.invalidateQueries({ queryKey: ['backups'] })}
        />
      )}
      <Section
        title={
          <span className="inline-flex items-center gap-2">
            <Archive className="size-4 text-muted" />
            Бэкапы конфигов
          </span>
        }
        info="В бэкап попадают конфиги и пользователи сервисов: 3X-UI (/etc/x-ui), WDTT (/etc/wdtt), MTProxyL (/opt/mtproxyl), Amnezia (ключи и clientsTable из контейнеров), сертификаты панели и acme.sh, настройки port-sync. Восстановление раскладывает данные на сервер, где эти сервисы уже установлены командами каталога."
        extra={<Chip>{mine.length}</Chip>}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!canAct}
            title={lock.reason}
            onClick={() => setCreateOpen(true)}
            label="Создать бэкап"
          >
            <Upload className="size-3.5" />
          </Button>
        }
      >
        <div className="hidden md:block">
          <Table>
            <THead>
              <tr>
                <th>Когда</th>
                <th>Что внутри</th>
                <th>Размер</th>
                <th />
              </tr>
            </THead>
            <TBody>
              {mine.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">
                    <div>{new Date(b.createdAt).toLocaleString('ru-RU')}</div>
                    <div className="text-xs text-muted">{ago(b.createdAt)}</div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">{components(b)}</div>
                  </td>
                  <td className="whitespace-nowrap text-muted">{bytes(b.size)}</td>
                  <td>
                    <div className="flex justify-end gap-1">{backupActions(b)}</div>
                  </td>
                </tr>
              ))}
              {mine.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted">
                    Бэкапов этого сервера ещё нет
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
        </div>
        {/* на мобиле - карточки: кнопки таблицы уходят за край экрана */}
        <div className="divide-y divide-border md:hidden">
          {mine.map((b) => (
            <div key={b.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span>{new Date(b.createdAt).toLocaleString('ru-RU')}</span>
                <span className="text-xs text-muted">{ago(b.createdAt)}</span>
                <div className="grow" />
                <span className="text-xs text-muted">{bytes(b.size)}</span>
              </div>
              <div className="flex flex-wrap gap-1">{components(b)}</div>
              <div className="-ml-2 flex gap-1">{backupActions(b)}</div>
            </div>
          ))}
          {mine.length === 0 && (
            <div className="px-4 py-4 text-center text-muted">Бэкапов этого сервера ещё нет</div>
          )}
        </div>
      </Section>

      <CreateDialog
        serverId={s.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onStarted={(id) => {
          setCreateOpen(false);
          setAction({ id, title: 'Создание бэкапа' });
        }}
      />
      {/* окно монтируется при открытии: каждое открытие - с чистой формой, без прошлой ошибки */}
      {restore && (
        <RestoreDialog
          backup={restore}
          defaultServerId={s.id}
          onClose={() => setRestore(null)}
          onStarted={(id, title) => {
            setRestore(null);
            setAction({ id, title });
          }}
        />
      )}
    </>
  );
}

function CreateDialog({
  serverId,
  open,
  onClose,
  onStarted,
}: {
  serverId: string;
  open: boolean;
  onClose: () => void;
  onStarted: (actionId: string) => void;
}) {
  const [components, setComponents] = useState<Component[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setComponents(null);
    setError(null);
    backupsApi
      .components(serverId)
      .then((c) => {
        setComponents(c);
        setChosen(c.map((x) => x.id));
      })
      .catch((e: Error) => setError(e.message));
  }, [open, serverId]);
  return (
    <Dialog open={open} onClose={onClose} title="Создать бэкап">
      {error && <Alert tone="bad">{error}</Alert>}
      {!components && !error && (
        <div className="text-sm text-muted">Агент смотрит, что есть на сервере...</div>
      )}
      {components && components.length === 0 && (
        <Alert>На сервере нет сервисов, конфиги которых можно сохранить.</Alert>
      )}
      {components && components.length > 0 && (
        <div className="flex flex-col gap-2 text-sm">
          {components.map((c) => (
            <Checkbox
              key={c.id}
              checked={chosen.includes(c.id)}
              onChange={() =>
                setChosen((v) => (v.includes(c.id) ? v.filter((x) => x !== c.id) : [...v, c.id]))
              }
              label={
                <>
                  {c.title}
                  {c.sizeBytes ? (
                    <span className="ml-1 text-xs text-muted">({bytes(c.sizeBytes)})</span>
                  ) : null}
                </>
              }
            />
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Отмена</Button>
        <Button
          variant="primary"
          disabled={busy || !components || chosen.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await backupsApi.create(serverId, chosen);
              onStarted(r.actionId);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Создать
        </Button>
      </div>
    </Dialog>
  );
}

function RestoreDialog({
  backup,
  defaultServerId,
  onClose,
  onStarted,
}: {
  backup: Backup | null;
  defaultServerId: string;
  onClose: () => void;
  onStarted: (actionId: string, title: string) => void;
}) {
  const { data: servers } = useServers();
  const [target, setTarget] = useState(defaultServerId);
  const [chosen, setChosen] = useState<string[]>([]);
  const [initFor, setInitFor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (backup && initFor !== backup.id) {
    setInitFor(backup.id);
    setChosen((backup.manifest.components ?? []).map((c) => c.id));
    setTarget(defaultServerId);
    setError(null);
  }
  const comps = backup?.manifest.components ?? [];
  const t = servers?.find((x) => x.id === target);
  return (
    <Dialog open={backup !== null} onClose={onClose} title="Восстановить бэкап">
      {backup && (
        <>
          <div className="text-[13px] text-muted">
            Бэкап с <b className="text-text">{backup.serverName || backup.hostname}</b> от{' '}
            {new Date(backup.createdAt).toLocaleString('ru-RU')}. На целевом сервере сервисы должны
            быть уже установлены (командами из каталога); их текущие конфиги сохраняются рядом с
            пометкой before-restore.
          </div>
          <Field label="Куда" htmlFor="restore-target">
            <Select id="restore-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {(servers ?? []).map((sv) => (
                <option key={sv.id} value={sv.id} disabled={sv.status !== 'online'}>
                  {sv.name} - {sv.host} {sv.status === 'online' ? '' : '(нет связи)'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-2 text-sm">
            <Label>Что восстанавливать</Label>
            {comps.map((c) => {
              const missing =
                t &&
                ((c.id === 'xui' && !t.services.some((x) => x.kind === 'xui')) ||
                  (c.id === 'wdtt' && !t.services.some((x) => x.kind === 'wdtt')) ||
                  (c.id === 'mtproxyl' && !t.services.some((x) => x.kind === 'mtproxyl')));
              return (
                <Checkbox
                  key={c.id}
                  checked={chosen.includes(c.id)}
                  onChange={() =>
                    setChosen((v) =>
                      v.includes(c.id) ? v.filter((x) => x !== c.id) : [...v, c.id],
                    )
                  }
                  label={c.title}
                  hint={
                    missing ? (
                      <span className="text-warn">
                        на целевом сервере сервис не найден, шаг будет пропущен
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
          {target === backup.serverId && (
            <Alert>
              Это тот же сервер, с которого снят бэкап: конфиги вернутся к состоянию на момент
              бэкапа.
            </Alert>
          )}
          {error && <Alert tone="bad">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button
              variant="danger"
              disabled={busy || chosen.length === 0 || !t || t.status !== 'online'}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await backupsApi.restore(backup.id, target, chosen);
                  onStarted(r.actionId, `Восстановление на ${t?.name ?? ''}`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Восстановить
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
