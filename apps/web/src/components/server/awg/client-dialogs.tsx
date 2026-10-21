import { DeviceSelect } from '@/components/device-select';
import { ClientConfig } from '@/components/links/awg-config';
import { OwnerLink } from '@/components/owner-link';
import { type AwgClient, clientTitle, isOnline } from '@/components/server/awg/model';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { ago, bytes } from '@/lib/format';
import { type GOwner, deviceOf } from '@vps/protocol';
import { Pencil, Power, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';

/** Окно пользователя: состояние, управление, адрес, трафик, откуда взялся. */
export function ClientInfo({
  c,
  serverId,
  container,
  disabled,
  reason,
  onOp,
  owner,
}: {
  c: AwgClient;
  owner: GOwner | undefined;
  serverId: string;
  container: string;
  disabled: boolean;
  reason: string | undefined;
  onOp: (op: string, name?: string, device?: string) => Promise<void>;
}) {
  const ask = useConfirm();
  const [edit, setEdit] = useState<{ name: string; device: string } | null>(null);
  const on = isOnline(c);
  const off = c.disabled || !c.inConfig;
  const source = c.managed
    ? 'панель'
    : !c.inTable
      ? 'приложение Amnezia или вручную (нет в clientsTable)'
      : 'приложение Amnezia';
  const rows: [string, string][] = [
    ['Устройство', deviceOf(c.device)?.title ?? 'не указано'],
    ['IP', c.allowedIps || '-'],
    [
      'Последнее подключение',
      c.handshake ? ago(new Date(c.handshake * 1000).toISOString()) : 'не подключался',
    ],
    ['Получено от пользователя', bytes(c.rx)],
    ['Отправлено пользователю', bytes(c.tx)],
    ['Адрес пользователя', c.endpoint || '-'],
    ['Создан', c.created || '-'],
    ['Откуда', source],
    ['Ключ', c.publicKey],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {off ? (
          <Chip tone="muted">выключен</Chip>
        ) : on ? (
          <Chip tone="ok" dot>
            на связи
          </Chip>
        ) : (
          <Chip>не на связи</Chip>
        )}
        {owner && <OwnerLink owner={owner} device={false} />}
        <div className="grow" />
        <Button
          size="sm"
          disabled={disabled}
          title={reason}
          onClick={() => void onOp(off ? 'client.enable' : 'client.disable')}
        >
          <Power className="size-3.5" />
          {off ? 'Включить' : 'Выключить'}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={disabled}
          title={reason}
          onClick={async () => {
            const ok = await ask({
              title: `Удалить пользователя \u00ab${clientTitle(c)}\u00bb?`,
              text: 'Конфиг пользователя перестанет работать',
              okLabel: 'Удалить',
              danger: true,
            });
            if (ok) await onOp('client.remove');
          }}
        >
          <Trash2 className="size-3.5" />
          Удалить
        </Button>
      </div>
      {edit === null ? (
        <Button
          variant="link"
          className="self-start text-xs"
          disabled={disabled}
          onClick={() => setEdit({ name: c.name, device: c.device ?? '' })}
        >
          <Pencil className="size-3" />
          Изменить имя и устройство
        </Button>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await onOp('client.rename', edit.name.trim(), edit.device);
            setEdit(null);
          }}
        >
          <Input
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            maxLength={64}
            autoFocus
            aria-label="Имя пользователя"
            className="min-w-0 basis-full sm:basis-0 sm:grow"
          />
          <DeviceSelect
            value={edit.device}
            onChange={(device) => setEdit({ ...edit, device })}
            className="min-w-0 basis-full sm:basis-40"
          />
          <Button type="submit" variant="primary" disabled={disabled || !edit.name.trim()}>
            Сохранить
          </Button>
          <Button onClick={() => setEdit(null)}>Отмена</Button>
        </form>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted">{k}</dt>
            <dd
              className={cn('min-w-0 break-words', k === 'Ключ' && 'font-mono text-xs break-all')}
            >
              {v}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="border-t border-border" />
      {c.managed ? (
        <ClientConfig
          // смена устройства - заново MTU по умолчанию
          key={c.device ?? ''}
          serverId={serverId}
          container={container}
          publicKey={c.publicKey}
          name={clientTitle(c)}
          device={c.device}
        />
      ) : (
        <div className="text-xs text-muted">
          Конфиг недоступен: приватного ключа пользователя нет ни в панели, ни на сервере. Для
          нового конфига нужен новый пользователь.
        </div>
      )}
    </div>
  );
}

export function AddClient({
  container,
  busy,
  onSubmit,
}: {
  container: string;
  busy: boolean;
  onSubmit: (name: string, device: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(name.trim(), device);
      }}
    >
      <Field label="Имя" htmlFor="awg-name" hint={`видно только в панели, экземпляр ${container}`}>
        <Input
          id="awg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ivan-iphone"
          maxLength={64}
          required
          autoFocus
        />
      </Field>
      <Field label="Устройство" htmlFor="awg-device" hint="по нему выбирается MTU конфига">
        <DeviceSelect id="awg-device" value={device} onChange={setDevice} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Добавить
        </Button>
      </div>
    </form>
  );
}
