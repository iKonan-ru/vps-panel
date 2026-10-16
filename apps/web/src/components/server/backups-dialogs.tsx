import { ServerOptions } from '@/components/server-options';
import { type Backup, type Component, backupsApi } from '@/components/server/backups-model';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { bytes, dateTime } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useEffect, useState } from 'react';

export function CreateDialog({
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
  const save = useAction();
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
      {(error ?? save.error) && <Alert tone="bad">{error ?? save.error}</Alert>}
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
          disabled={save.busy || !components || chosen.length === 0}
          onClick={() =>
            save.run(async () => {
              const r = await backupsApi.create(serverId, chosen);
              onStarted(r.actionId);
            })
          }
        >
          Создать
        </Button>
      </div>
    </Dialog>
  );
}

export function RestoreDialog({
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
  const save = useAction();
  if (backup && initFor !== backup.id) {
    setInitFor(backup.id);
    setChosen((backup.manifest.components ?? []).map((c) => c.id));
    setTarget(defaultServerId);
    save.setError(null);
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
              <ServerOptions servers={servers} withHost onlineOnly />
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
          {save.error && <Alert tone="bad">{save.error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button
              variant="danger"
              disabled={save.busy || chosen.length === 0 || !t || t.status !== 'online'}
              onClick={() =>
                save.run(async () => {
                  const r = await backupsApi.restore(backup.id, target, chosen);
                  onStarted(r.actionId, `Восстановление на ${t?.name ?? ''}`);
                })
              }
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
