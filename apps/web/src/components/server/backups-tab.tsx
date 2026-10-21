import { ActionPanel } from '@/components/action-output';
import { CreateDialog, RestoreDialog } from '@/components/server/backups-dialogs';
import { backupsApi } from '@/components/server/backups-model';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Presence } from '@/components/ui/presence';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, bytes, dateTime } from '@/lib/format';
import { serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupInfo, ServerDetail } from '@vps/protocol';
import { Archive, ArchiveRestore, Download, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';

/** Вкладка "Бэкапы": создание, копии этого сервера и восстановление на любой сервер. */
export function BackupsTab({ s }: { s: ServerDetail }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const online = s.status === 'online';
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
  const op = useAction();
  const [action, setAction] = useState<{ id: string; title: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [restore, setRestore] = useState<BackupInfo | null>(null);

  async function remove(b: BackupInfo) {
    const ok = await ask({
      title: `Удалить резервную копию от ${dateTime(b.createdAt)}?`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      await backupsApi.remove(b.id);
      await qc.invalidateQueries({ queryKey: ['backups'] });
    });
  }

  const components = (b: BackupInfo) =>
    (b.manifest.components ?? []).map((c) => (
      <Chip key={c.id} title={c.title}>
        {c.id}
      </Chip>
    ));
  /** Кнопки бэкапа: в строке таблицы и в карточке на мобиле. */
  const backupActions = (b: BackupInfo) => (
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
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      {action && (
        <ActionPanel title={action.title} actionId={action.id} onHide={() => setAction(null)} />
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
              <div className="mt-1 flex gap-1">{backupActions(b)}</div>
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
      <Presence value={restore}>
        {(backup) => (
          <RestoreDialog
            backup={backup}
            defaultServerId={s.id}
            onClose={() => setRestore(null)}
            onStarted={(id, title) => {
              setRestore(null);
              setAction({ id, title });
            }}
          />
        )}
      </Presence>
    </>
  );
}
