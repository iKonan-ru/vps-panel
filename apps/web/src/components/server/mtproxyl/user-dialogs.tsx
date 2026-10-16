import { MtLinksView } from '@/components/links/mt-links';
import { OwnerLink } from '@/components/owner-link';
import { type MtTraffic, type MtUser, mtApi } from '@/components/server/mtproxyl/model';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { bytes } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { type GOwner, parseMtLinks } from '@vps/protocol';
import { Pencil, Power, Trash2 } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';

/** Окна пользователя MTProxyL: карточка со ссылками и трафиком, добавление. */

/** Дата создания: mtproxyl отдаёт unix-время в секундах (на всякий случай понимаем и мс). */
function createdAt(v: number): string {
  if (!v) return '-';
  const d = new Date(v > 1e12 ? v : v * 1000);
  return d.toLocaleDateString('ru-RU');
}

/** Окно пользователя, верхняя часть: состояние, управление, трафик, подключения. */
export function UserInfo({
  u,
  traffic,
  disabled,
  reason,
  onToggle,
  onRemove,
  onRename,
  owner,
}: {
  u: MtUser;
  owner: GOwner | undefined;
  traffic: MtTraffic | undefined;
  disabled: boolean;
  reason: string | undefined;
  onToggle: () => void;
  onRemove: () => void;
  /** Бросает ошибку, если mtproxyl отказал (имя занято и т.п.). */
  onRename: (name: string) => Promise<void>;
}) {
  const [rename, setRename] = useState<string | null>(null);
  const save = useAction();
  const validName = (v: string) => /^[a-zA-Z0-9_-]{1,32}$/.test(v);
  const rows: [string, string][] = [
    ['Трафик', bytes(traffic?.total ?? u.total_bytes)],
    ['Сейчас онлайн', `подключений: ${traffic?.connections ?? 0}, IP: ${traffic?.unique_ips ?? 0}`],
    ['Создан', createdAt(u.created)],
    ...(u.ad_tag ? ([['Рекламный тег', u.ad_tag]] as [string, string][]) : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {u.enabled ? <Chip tone="ok">включён</Chip> : <Chip tone="muted">выключен</Chip>}
        {owner && <OwnerLink owner={owner} />}
        <div className="grow" />
        <Button size="sm" disabled={disabled} title={reason} onClick={onToggle}>
          <Power className="size-3.5" />
          {u.enabled ? 'Выключить' : 'Включить'}
        </Button>
        <Button size="sm" variant="danger" disabled={disabled} title={reason} onClick={onRemove}>
          <Trash2 className="size-3.5" />
          Удалить
        </Button>
      </div>
      {rename === null ? (
        <Button
          variant="link"
          className="self-start text-xs"
          disabled={disabled}
          title={reason}
          onClick={() => {
            setRename(u.label);
            save.setError(null);
          }}
        >
          <Pencil className="size-3" />
          Переименовать
        </Button>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = rename.trim();
            if (name === u.label) {
              setRename(null);
              return;
            }
            if (await save.run(() => onRename(name))) setRename(null);
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              maxLength={32}
              autoFocus
              aria-label="Новое имя пользователя"
              className="min-w-0 basis-full font-mono sm:basis-0 sm:grow"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={disabled || save.busy || !validName(rename.trim())}
            >
              Сохранить
            </Button>
            <Button onClick={() => setRename(null)}>Отмена</Button>
            <InfoTip>Латиница, цифры, _ и -, до 32&nbsp;символов. Ссылки не изменятся.</InfoTip>
          </div>
          {save.error && <Alert tone="bad">{save.error}</Alert>}
        </form>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="border-t border-border" />
    </div>
  );
}

/**
 * Окно пользователя: переключатель TLS (tg://proxy, по умолчанию) и t.me (https://t.me/proxy),
 * QR-код, кнопка "Подключить прокси" (открывает ссылку в Telegram) и копирование выбранной
 * ссылки. Ссылки не кэшируются: в них секрет.
 */
export function UserLinks({ serverId, label }: { serverId: string; label: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['mtproxyl-link', serverId, label],
    queryFn: () => mtApi.exec(serverId, 'secret.link', { label }),
    gcTime: 0,
  });
  if (isLoading) return <div className="text-sm text-muted">Загрузка&hellip;</div>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  const text = data?.output ?? '';
  return <MtLinksView links={parseMtLinks(text)} label={label} raw={text} />;
}

export function AddForm({
  busy,
  onSubmit,
}: { busy: boolean; onSubmit: (label: string, secret: string) => void }) {
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(label.trim(), secret.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Метка" htmlFor="mt-label" hint={'латиница, цифры, _ и -, до 32\u00a0символов'}>
        <Input
          id="mt-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="ivan"
          required
          pattern="[A-Za-z0-9_-]{1,32}"
          className="font-mono"
        />
      </Field>
      <Field label="Секрет" htmlFor="mt-secret" hint="если пусто, сгенерируется">
        <Input
          id="mt-secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          pattern="[0-9a-fA-F]{32}"
          className="font-mono"
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !label.trim()}>
          Добавить
        </Button>
      </div>
    </form>
  );
}
