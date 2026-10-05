import { useOwners } from '@/components/owner-link';
import { AddClient, ClientInfo } from '@/components/server/awg/client-dialogs';
import { Instance } from '@/components/server/awg/instance';
import { type AwgStatus, clientTitle } from '@/components/server/awg/model';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Вкладка AWG: экземпляры AmneziaWG (контейнеры amnezia-awg*), их версии и клиенты;
 * добавление, выключение, переименование и удаление клиентов.
 */
export function AwgTab({ s }: { s: ServerDetail }) {
  const owner = useOwners(s.id);
  const qc = useQueryClient();
  const online = s.status === 'online';
  const { data, error, isFetching } = useQuery({
    queryKey: ['awg', s.id],
    queryFn: () => api<AwgStatus>(`/api/servers/${s.id}/awg`),
    enabled: online,
    staleTime: 20_000,
  });
  // окно клиента: храним адрес, а клиента берём из свежих данных - после операций он меняется
  const [open, setOpen] = useState<{ container: string; publicKey: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const lock = serverLock(s);
  // ошибка - того окна, где была операция: открыли или закрыли окно клиента - сброс
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс при смене окна
  useEffect(() => setOpError(null), [open, adding]);

  /** Операция над клиентом; после неё - свежий статус. null - ошибка (показана в окне). */
  async function exec(
    op: string,
    container: string,
    publicKey?: string,
    name?: string,
    device?: string,
  ) {
    setBusy(true);
    setOpError(null);
    try {
      const r = await api<{ ip?: string; publicKey: string }>(`/api/servers/${s.id}/awg/exec`, {
        method: 'POST',
        json: { op, container, publicKey, name, device },
      });
      await qc.invalidateQueries({ queryKey: ['awg', s.id] });
      return r;
    } catch (e) {
      setOpError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!online) return <Card className="p-8 text-[13px] text-muted">Агент не на связи.</Card>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <Card className="p-8 text-[13px] text-muted">Опрашиваю контейнеры AWG...</Card>;
  const openClient = open
    ? data.instances
        .find((i) => i.container === open.container)
        ?.clients.find((c) => c.publicKey === open.publicKey)
    : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {data.hostModule && (
          <span className="text-xs text-muted" title="Модуль amneziawg в ядре хоста">
            модуль ядра хоста {data.hostModule}
          </span>
        )}
        <div className="grow" />
        {data.instances.length > 0 && (
          <ButtonLink
            to="/commands/$id"
            params={{ id: 'awg' }}
            search={{ server: s.id, run: undefined, tab: undefined }}
            size="sm"
            variant="ghost"
            label="Новый экземпляр"
            title="Ещё один экземпляр со своей версией, портом и подсетью (команда Amnezia AWG)"
          >
            <Plus className="size-3.5" />
          </ButtonLink>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={isFetching}
          onClick={() => void qc.invalidateQueries({ queryKey: ['awg', s.id] })}
          title="Обновить данные"
          aria-label="Обновить данные"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>

      {data.instances.length === 0 && (
        <Card className="flex flex-col items-start gap-3 p-6 text-[13px] text-muted">
          Контейнеров AmneziaWG на сервере не найдено.
          <ButtonLink
            to="/commands/$id"
            params={{ id: 'awg' }}
            search={{ server: s.id, run: undefined, tab: undefined }}
            size="sm"
            label="Установить AWG"
          >
            <Plus className="size-3.5" />
          </ButtonLink>
        </Card>
      )}

      {data.instances.map((inst) => (
        <Instance
          key={inst.container}
          inst={inst}
          owner={(key) => owner('awg', key)}
          onClient={(c) => setOpen({ container: inst.container, publicKey: c.publicKey })}
          onAdd={() => setAdding(inst.container)}
          addDisabled={busy || lock.busy}
          addTitle={lock.reason}
          onSetParams={async (profile) => {
            setBusy(true);
            try {
              await api(`/api/servers/${s.id}/awg/exec`, {
                method: 'POST',
                json: { op: 'instance.setparams', container: inst.container, profile },
              });
              await qc.invalidateQueries({ queryKey: ['awg', s.id] });
              await qc.invalidateQueries({ queryKey: ['awg-config'] });
              return null;
            } catch (e) {
              return (e as Error).message;
            } finally {
              setBusy(false);
            }
          }}
        />
      ))}

      <Dialog
        open={openClient !== undefined}
        onClose={() => setOpen(null)}
        title={openClient ? clientTitle(openClient) : ''}
      >
        {open && openClient && (
          <ClientInfo
            c={openClient}
            serverId={s.id}
            owner={owner('awg', openClient.publicKey)}
            container={open.container}
            disabled={busy || lock.busy}
            reason={lock.reason}
            onOp={async (op, name, device) => {
              const r = await exec(op, open.container, openClient.publicKey, name, device);
              if (r && op === 'client.remove') setOpen(null);
            }}
          />
        )}
        {opError && <Alert tone="bad">{opError}</Alert>}
        <div className="flex justify-end">
          <Button onClick={() => setOpen(null)}>Закрыть</Button>
        </div>
      </Dialog>

      <Dialog open={adding !== null} onClose={() => setAdding(null)} title="Новый клиент AWG">
        <AddClient
          container={adding ?? ''}
          busy={busy || lock.busy}
          onSubmit={async (name, device) => {
            const container = adding ?? '';
            const r = await exec('client.add', container, undefined, name, device);
            if (r) {
              setAdding(null);
              setOpen({ container, publicKey: r.publicKey });
            }
          }}
        />
        {opError && <Alert tone="bad">{opError}</Alert>}
      </Dialog>
    </>
  );
}
