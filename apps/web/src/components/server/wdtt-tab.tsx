import { type WdttLinks, WdttLinksView } from '@/components/links/wdtt-links';
import { OwnerLink, useOwners, useWdttKeys } from '@/components/owner-link';
import { UninstallBlock } from '@/components/server/uninstall-block';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power, QrCode as QrCodeIcon, Trash2, Unlink } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface WdttPassword {
  password: string;
  label: string;
  max_devices: number;
  device_ids: string[];
  expires_at: number;
  is_deactivated: boolean;
  down_bytes: number;
  up_bytes: number;
  active_devices: number;
  links: WdttLinks;
}

interface WdttData {
  limit: number;
  dtlsPort: number;
  hashes: number;
  passwords: WdttPassword[];
}

const expiresLabel = (unix: number) => {
  if (!unix) return 'без срока';
  const days = Math.ceil((unix * 1000 - Date.now()) / 86_400_000);
  return days <= 0 ? 'истёк' : `ещё ${days} дн.`;
};

/**
 * Вкладка WDTT: пароли пользователей через admin API сервера.
 * Пароль генерирует сервер, у него срок, лимит устройств и трафик; ссылки - для приложений.
 */
export function WdttTab({ s }: { s: ServerDetail }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const online = s.status === 'online';
  const lock = serverLock(s);
  const { data, error } = useQuery({
    queryKey: ['wdtt', s.id],
    queryFn: () => api<WdttData>(`/api/servers/${s.id}/wdtt`),
    enabled: online,
    // подключённые устройства - живые, но каждый опрос идёт через агента к admin API: раз в минуту
    refetchInterval: 60_000,
  });
  const owner = useOwners(s.id);
  const keys = useWdttKeys((data?.passwords ?? []).map((p) => p.password));
  const [add, setAdd] = useState(false);
  const [links, setLinks] = useState<WdttPassword | null>(null);
  const [edit, setEdit] = useState<WdttPassword | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['wdtt', s.id] });
  // пока идёт операция, остальные кнопки вкладки недоступны (двойной тап, соседний пароль)
  const op = useAction();
  async function call(fn: () => Promise<unknown>) {
    setErr(null);
    await op.run(async () => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }
  const blocked = lock.busy || op.busy;

  if (!online) return <Card className="p-8 text-[13px] text-muted">Агент не на связи.</Card>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <Card className="p-8 text-[13px] text-muted">Опрашиваю WDTT...</Card>;

  const full = data.passwords.length >= data.limit;
  return (
    <>
      {err && <Alert tone="bad">{err}</Alert>}
      {data.hashes === 0 && (
        <Alert tone="info">
          Хеши звонков VK в настройках панели не заданы: клиенты добавляют свои в приложении (вход в
          аккаунт VK). Общие хеши - в Настройках, блок "WDTT: хеши звонков VK".
        </Alert>
      )}
      <Section
        title="Пользователи WDTT"
        info="Пароль генерирует сервер. Один пароль - один человек, на нём до стольких устройств, сколько указано. Ссылки qwdtt:// и wdtt:// добавляются в приложение qWDTT."
        extra={
          <Chip title="Паролей на сервере из лимита WDTT">
            {data.passwords.length} из {data.limit}
          </Chip>
        }
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={blocked || full}
            title={full ? 'Достигнут лимит паролей на сервере' : lock.reason}
            onClick={() => setAdd(true)}
            label="Добавить"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {data.passwords.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">
            Пользователей пока нет. Нажми "Добавить": сервер создаст пароль и ссылки.
          </div>
        )}
        {data.passwords.map((p) => {
          const own = owner('wdtt', keys?.get(p.password));
          return (
            <div
              key={p.password}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 grow">
                <div className="flex min-w-0 items-center gap-2 text-[13px]">
                  <span className="truncate font-medium">{p.label}</span>
                  {p.is_deactivated && <Chip tone="muted">выключен</Chip>}
                  {own && <OwnerLink owner={own} />}
                </div>
                <div className="text-xs text-muted">
                  устройств {p.active_devices}/{p.max_devices}, {expiresLabel(p.expires_at)}, трафик{' '}
                  {bytes(p.down_bytes + p.up_bytes)}
                </div>
              </div>
              <ActionBar
                dense
                actions={[
                  {
                    key: 'links',
                    label: 'Ссылки',
                    icon: <QrCodeIcon className="size-3.5" />,
                    onClick: () => setLinks(p),
                    mobile: true,
                  },
                  {
                    key: 'edit',
                    label: 'Изменить',
                    icon: <Pencil className="size-3.5" />,
                    disabled: blocked,
                    onClick: () => setEdit(p),
                  },
                  {
                    key: 'toggle',
                    label: p.is_deactivated ? 'Включить' : 'Выключить',
                    icon: <Power className="size-3.5" />,
                    disabled: blocked,
                    onClick: () =>
                      void call(() =>
                        api(
                          `/api/servers/${s.id}/wdtt/passwords/${p.is_deactivated ? 'activate' : 'deactivate'}`,
                          { method: 'POST', json: { password: p.password, label: p.label } },
                        ),
                      ),
                  },
                  {
                    key: 'unbind',
                    label: 'Отвязать устройства',
                    icon: <Unlink className="size-3.5" />,
                    hidden: (p.device_ids ?? []).length === 0,
                    disabled: blocked,
                    title: 'Отвязать все устройства (можно будет подключить заново)',
                    onClick: async () => {
                      const ok = await ask({
                        title: `Отвязать устройства ${p.label}?`,
                        text: 'Устройства отключатся; подключить их заново можно той же ссылкой.',
                        okLabel: 'Отвязать',
                      });
                      if (ok)
                        await call(() =>
                          api(`/api/servers/${s.id}/wdtt/passwords/unbind-device`, {
                            method: 'POST',
                            json: { password: p.password, label: p.label },
                          }),
                        );
                    },
                  },
                  {
                    key: 'remove',
                    label: 'Удалить пароль',
                    icon: <Trash2 className="size-3.5" />,
                    variant: 'danger',
                    group: 'danger',
                    disabled: blocked,
                    onClick: async () => {
                      const ok = await ask({
                        title: `Удалить пользователя ${p.label}?`,
                        text: 'Его ссылки перестанут работать.',
                        okLabel: 'Удалить',
                        danger: true,
                      });
                      if (ok)
                        await call(() =>
                          api(`/api/servers/${s.id}/wdtt/passwords/delete`, {
                            method: 'POST',
                            json: { password: p.password, label: p.label },
                          }),
                        );
                    },
                  },
                ]}
              />
            </div>
          );
        })}
      </Section>

      <UninstallBlock
        serverId={s.id}
        kind="wdtt"
        title="WDTT"
        loses="сервер WDTT и пароли всех пользователей пропадут, приложения перестанут подключаться."
        disabled={blocked}
        reason={lock.reason}
      />

      <Dialog open={add} onClose={() => setAdd(false)} title="Новый пользователь WDTT">
        <PasswordForm
          onSubmit={async (v) => {
            // ошибка - внутри окна (PasswordForm), окно закрывается только при успехе
            await api(`/api/servers/${s.id}/wdtt/passwords`, { method: 'POST', json: v });
            await refresh();
            setAdd(false);
          }}
        />
      </Dialog>
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title="Изменить пользователя">
        {edit && (
          <PasswordForm
            initial={edit}
            onSubmit={async (v) => {
              await api(`/api/servers/${s.id}/wdtt/passwords/update`, {
                method: 'POST',
                json: { password: edit.password, ...v },
              });
              await refresh();
              setEdit(null);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={links !== null}
        onClose={() => setLinks(null)}
        title={links ? `Ссылки: ${links.label}` : ''}
      >
        {links && <WdttLinksView links={links.links} />}
      </Dialog>
    </>
  );
}

function PasswordForm({
  initial,
  onSubmit,
}: {
  initial?: WdttPassword;
  onSubmit: (v: { label: string; maxDevices: number; days?: number }) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [maxDevices, setMaxDevices] = useState(initial?.max_devices ?? 1);
  const [days, setDays] = useState(initial ? 0 : 365);
  const save = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    // days 0 при изменении - срок не трогаем
    void save.run(() =>
      onSubmit({ label: label.trim(), maxDevices, ...(days > 0 ? { days } : {}) }),
    );
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="Имя" htmlFor="wd-label" hint="видно только в панели">
        <Input
          id="wd-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={64}
          required
          autoFocus
          placeholder="например, Иван"
        />
      </Field>
      <Field label="Устройств одновременно" htmlFor="wd-dev">
        <Input
          id="wd-dev"
          type="number"
          min={1}
          max={50}
          value={maxDevices}
          onChange={(e) => setMaxDevices(Number(e.target.value))}
        />
      </Field>
      <Field label={initial ? 'Продлить, дней (0 - не менять)' : 'Срок, дней'} htmlFor="wd-days">
        <Input
          id="wd-days"
          type="number"
          min={0}
          max={365}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
      </Field>
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.busy || !label.trim()}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}
