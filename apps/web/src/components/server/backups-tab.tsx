import { ActionPanel } from '@/components/action-output';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink, buttonClass } from '@/components/ui/button';
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
import { ago, bytes, dateTime } from '@/lib/format';
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
  // пароль резервных копий общий с копией панели: им шифруются скачанные файлы
  const { data: pb } = useQuery({
    queryKey: ['panel-backup'],
    queryFn: () => api<{ passwordSet: boolean }>('/api/panel-backup'),
  });
  const passwordSet = pb?.passwordSet ?? false;
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; title: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [restore, setRestore] = useState<Backup | null>(null);

  async function remove(b: Backup) {
    const ok = await ask({
      title: `Удалить резервную копию от ${dateTime(b.createdAt)}?`,
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
    <ActionBar
      dense
      actions={[
        // файл шифруется паролем резервных копий: без пароля скачать нечем
        passwordSet
          ? {
              key: 'download',
              label: 'Скачать',
              icon: <Download className="size-3.5" />,
              href: `/api/backups/${b.id}/download`,
              node: (
                <a
                  href={`/api/backups/${b.id}/download`}
                  download
                  className={buttonClass({ size: 'icon-sm', variant: 'ghost' })}
                  title="Скачать (зашифровано паролем резервных копий)"
                  aria-label="Скачать"
                >
                  <Download className="size-3.5" />
                </a>
              ),
            }
          : {
              key: 'download',
              label: 'Скачать',
              icon: <Download className="size-3.5" />,
              disabled: true,
              title: 'Нет пароля резервных копий: его задают в \u00abНастройках\u00bb',
            },
        {
          key: 'restore',
          label: 'Восстановить',
          icon: <ArchiveRestore className="size-3.5" />,
          onClick: () => setRestore(b),
          // восстановление и удаление - не поверх идущего бэкапа или другого действия
          disabled: !canAct,
          title: lock.reason,
          mobile: true,
        },
        {
          key: 'remove',
          label: 'Удалить копию',
          icon: <Trash2 className="size-3.5" />,
          variant: 'danger',
          group: 'danger',
          disabled: !canAct,
          title: lock.reason,
          onClick: () => void remove(b),
        },
      ]}
    />
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
            Резервные копии
          </span>
        }
        info="Конфиги и пользователи 3X-UI, WDTT, MTProxyL и Amnezia, сертификаты, настройки port-sync. Восстановление возможно на сервер, где эти сервисы уже установлены."
        extra={<Chip>{mine.length}</Chip>}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!canAct}
            title={lock.reason}
            onClick={() => setCreateOpen(true)}
            label="Создать копию"
          >
            <Upload className="size-3.5" />
          </Button>
        }
      >
        <div className="hidden md:block">
          <Table>
            <THead>
              <tr>
                <th>Дата</th>
                <th>Состав</th>
                <th>Размер</th>
                <th />
              </tr>
            </THead>
            <TBody>
              {mine.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">
                    <div>{dateTime(b.createdAt)}</div>
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
                    Копий пока нет
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
                <span>{dateTime(b.createdAt)}</span>
                <span className="text-xs text-muted">{ago(b.createdAt)}</span>
                <div className="grow" />
                <span className="text-xs text-muted">{bytes(b.size)}</span>
              </div>
              <div className="flex flex-wrap gap-1">{components(b)}</div>
              <div className="-ml-2 flex gap-1">{backupActions(b)}</div>
            </div>
          ))}
          {mine.length === 0 && (
            <div className="px-4 py-4 text-center text-muted">Копий пока нет</div>
          )}
        </div>
      </Section>

      <CreateDialog
        serverId={s.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onStarted={(id) => {
          setCreateOpen(false);
          setAction({ id, title: 'Создание резервной копии' });
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
    <Dialog open={open} onClose={onClose} title="Новая резервная копия">
      {error && <Alert tone="bad">{error}</Alert>}
      {!components && !error && <div className="text-sm text-muted">Загрузка&hellip;</div>}
      {components && components.length === 0 && (
        <Alert>На сервере нет сервисов для резервного копирования</Alert>
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
    <Dialog open={backup !== null} onClose={onClose} title="Восстановление копии">
      {backup && (
        <>
          <div className="text-[13px] text-muted">
            Копия <b className="text-text">{backup.serverName || backup.hostname}</b> от{' '}
            {dateTime(backup.createdAt)}. Сервисы на целевом сервере должны быть установлены, их
            текущие конфиги сохранятся с пометкой before-restore.
          </div>
          <Field label="Сервер" htmlFor="restore-target">
            <Select id="restore-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {(servers ?? []).map((sv) => (
                <option key={sv.id} value={sv.id} disabled={sv.status !== 'online'}>
                  {sv.name}, {sv.host}
                  {sv.status === 'online' ? '' : ' (не в сети)'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-2 text-sm">
            <Label>Состав</Label>
            {comps.map((c) => {
              const missing = t && serviceMissing(c.id, t);
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
                      <span className="text-warn">сервис не установлен, шаг пропускается</span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
          {t && target !== backup.serverId && backup.serverId && (
            <Alert>
              <div className="flex flex-col gap-2">
                <span>
                  Это копия другого сервера: восстановление разложит её данные без клиентов
                  панели&nbsp;&mdash; их записи окажутся чужими. Перенос ставит сервисы со старыми
                  портами, раскладывает данные и переводит сюда клиентов с теми же ключами.
                </span>
                <div>
                  <ButtonLink
                    size="sm"
                    to="/servers/$id/setup"
                    params={{ id: target }}
                    search={{ backup: backup.id, migrate: backup.serverId, wipe: undefined }}
                  >
                    Перенос на этот сервер
                  </ButtonLink>
                </div>
              </div>
            </Alert>
          )}
          {t && target === backup.serverId && comps.some((c) => serviceMissing(c.id, t)) && (
            <Alert>
              <div className="flex flex-col gap-2">
                <span>
                  На сервере нет сервисов из копии: настройка сервера поставит их сама, с прежними
                  портами, и разложит данные
                </span>
                <div>
                  <ButtonLink
                    size="sm"
                    to="/servers/$id/setup"
                    params={{ id: target }}
                    search={{ backup: backup.id, migrate: undefined, wipe: undefined }}
                  >
                    Восстановить с установкой сервисов
                  </ButtonLink>
                </div>
              </div>
            </Alert>
          )}
          {target === backup.serverId && (
            <Alert>Конфиги этого сервера вернутся к состоянию на момент создания копии</Alert>
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

/** Сервиса компонента копии нет на сервере (AWG - нет ни одного контейнера). */
function serviceMissing(component: string, s: { services: { kind: string }[] }): boolean {
  const kind = component === 'amnezia' ? 'amnezia' : component;
  if (!['xui', 'wdtt', 'mtproxyl', 'amnezia'].includes(kind)) return false;
  return !s.services.some((x) => x.kind === kind);
}
