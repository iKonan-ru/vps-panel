import { AccessEditor, accessRemoves } from '@/components/clients/access-editor';
import { pillLabel } from '@/components/clients/binding-pill';
import { DeviceSelect } from '@/components/device-select';
import { MtLinksView } from '@/components/links/mt-links';
import { WdttLinksView } from '@/components/links/wdtt-links';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LinkButton } from '@/components/ui/link-button';
import { QrCode } from '@/components/ui/qr-code';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import type { GBinding, GBindingLinks, GClientAccess, GDevice, GServer } from '@vps/protocol';
import { type FormEvent, useState } from 'react';

/** Окна карточки клиента: ссылки прокси, переименование, устройство, доступ. */

/** Ссылки MTProxy или WDTT привязки (из кэша панели). */
export function ProxyLinks({ clientId, binding }: { clientId: string; binding: GBinding }) {
  const { data, error } = useQuery({
    queryKey: ['gclient-links', binding.id],
    queryFn: () => api<GBindingLinks>(`/api/gclients/${clientId}/links/${binding.id}`),
    gcTime: 0,
  });
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <div className="text-sm text-muted">Загружаю...</div>;
  if (data.wdtt) return <WdttLinksView links={data.wdtt} />;
  if (binding.service === 'naive') {
    const link = data.links[0] ?? '';
    return (
      <div className="flex flex-col gap-3">
        <div className="text-[13px] text-muted">
          Прокси для браузера: расширение Chrome клиент скачивает на личной странице (блок "Браузер
          Chrome без программ"), адрес и пароль оно берёт из подписки само. Ссылка ниже - для
          приложений NaiveProxy (NekoBox и др.), в ней пароль.
        </div>
        <LinkButton href={link} size="md" wide copyTitle="Скопировать ссылку">
          naive+https
        </LinkButton>
      </div>
    );
  }
  if (binding.service === 'openflux') {
    const link = data.links[0] ?? '';
    return (
      <div className="flex flex-col gap-3">
        <div className="text-[13px] text-muted">
          Профиль для приложения OpenFlux: ссылка или QR-код. В ссылке ключ канала, канал - для
          одного устройства.
        </div>
        <QrCode text={link} alt="QR-код ссылки OpenFlux" level="L" />
        <LinkButton href={link} variant="primary" size="md" wide copyTitle="Скопировать ссылку">
          Открыть в OpenFlux
        </LinkButton>
      </div>
    );
  }
  return <MtLinksView links={data.links} label={binding.ref} />;
}

export function RenameForm({
  name: initial,
  note: initialNote,
  onSave,
}: { name: string; note: string; onSave: (name: string, note: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [note, setNote] = useState(initialNote);
  const save = useAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save.run(() => onSave(name.trim(), note));
      }}
    >
      <Field label="Имя" htmlFor="gc-rename">
        <Input
          id="gc-rename"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          autoFocus
        />
      </Field>
      <Field label="Заметка" htmlFor="gc-renote">
        <Input
          id="gc-renote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </Field>
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.busy || !name.trim()}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

export function DeviceForm({
  device,
  onSave,
}: {
  device: GDevice | null;
  onSave: (d: { name: string; type: string; awg20: boolean }) => Promise<void>;
}) {
  const [d, setD] = useState({
    name: device?.name ?? '',
    type: device?.type ?? '',
    awg20: device?.awg20 ?? false,
  });
  // двойной тап по "Сохранить" нового устройства заводил два устройства
  const save = useAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save.run(() => onSave({ ...d, name: d.name.trim() }));
      }}
    >
      <Field label="Устройство" htmlFor="gd-type" hint="по нему выбираются MTU и приложения">
        <DeviceSelect id="gd-type" value={d.type} onChange={(type) => setD({ ...d, type })} />
      </Field>
      <Field label="Название" htmlFor="gd-name">
        <Input
          id="gd-name"
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          maxLength={64}
          placeholder="например, iPhone 15"
        />
      </Field>
      <Checkbox
        checked={d.awg20}
        onChange={(e) => setD({ ...d, awg20: e.target.checked })}
        label="Ещё AWG 2.0 (старые приложения, роутеры)"
      />
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.busy || (!d.type && !d.name.trim())}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

/**
 * Доступ клиента к серверам и сервисам. Снятое сверка удаляет с серверов (как при удалении
 * клиента), поэтому сужение - с подтверждением; вернёшь - заведётся заново, конфиг AWG и ссылка
 * MTProxy будут новыми, подписка VLESS обновится сама.
 */
export function AccessForm({
  access: initial,
  bindings,
  devices,
  onSave,
}: {
  access: GClientAccess;
  bindings: GBinding[];
  devices: GDevice[];
  onSave: (access: GClientAccess) => Promise<void>;
}) {
  const [access, setAccess] = useState(initial);
  const { data: servers } = useQuery({
    queryKey: ['gclient-servers'],
    queryFn: () => api<GServer[]>('/api/gclients/servers'),
  });
  const ask = useConfirm();
  const save = useAction();
  const removes = accessRemoves(bindings, access);
  const removed = [...new Set(removes.map((b) => b.serverName))].map(
    (server) =>
      `${server}: ${removes
        .filter((b) => b.serverName === server)
        .map((b) =>
          pillLabel(
            b,
            devices.find((d) => d.id === b.deviceId),
          ),
        )
        .join(', ')}`,
  );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save.run(async () => {
          if (
            removes.length > 0 &&
            !(await ask({
              title: 'Убрать с серверов?',
              text: 'Отмеченное ниже сверка удалит с серверов. Вернёшь доступ - заведётся заново: конфиг AWG и ссылка MTProxy будут новыми.',
              okLabel: 'Убрать',
              danger: true,
            }))
          )
            return;
          await onSave(access);
        });
      }}
    >
      <AccessEditor
        value={access}
        onChange={setAccess}
        servers={servers ?? []}
        bindings={bindings}
      />
      {removed.length > 0 && (
        <Alert tone="info">
          Будет удалено с серверов:
          {removed.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </Alert>
      )}
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.busy}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}
