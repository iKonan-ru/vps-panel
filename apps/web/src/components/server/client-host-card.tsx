import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, SearchCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface ClientHost {
  host: string;
  clientHost: string;
  suggestion: string;
}
interface Check {
  ok: boolean;
  addresses: string[];
  error?: string;
}

/** Адрес в конфигах клиентов - IP или имя: с именем смена IP не трогает конфиги людей. */
export function ClientHostCard({ serverId }: { serverId: string }) {
  const { data } = useQuery({
    queryKey: ['client-host', serverId],
    queryFn: () => api<ClientHost>(`/api/servers/${serverId}/client-host`),
  });
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const named = Boolean(data.clientHost);
  return (
    <Section
      title="Адрес для клиентов"
      info={
        'С именем смена IP\u00a0\u2014 правка одной записи в DNS, конфиги клиентов не меняются. С IP после смены адреса выданные AWG, WDTT и OpenFlux перестанут работать.'
      }
      extra={<Chip tone={named ? 'ok' : 'muted'}>{named ? 'имя' : 'IP'}</Chip>}
      actions={
        <Button size="sm" onClick={() => setOpen(true)} label="Изменить">
          <Pencil className="size-3.5" />
        </Button>
      }
    >
      <div className="px-4 py-3 text-[13px]">
        <span className="font-mono">{data.clientHost || data.host}</span>
        {named && <span className="text-muted">, указывает на {data.host}</span>}
        {!named && (
          <div className="mt-1 text-xs text-muted">
            Надёжнее имя, например <span className="font-mono">{data.suggestion}</span> с A-записью
            на {data.host}
          </div>
        )}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Адрес для клиентов">
        {open && <ClientHostForm serverId={serverId} data={data} onDone={() => setOpen(false)} />}
      </Dialog>
    </Section>
  );
}

function ClientHostForm({
  serverId,
  data,
  onDone,
}: {
  serverId: string;
  data: ClientHost;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(data.clientHost || data.suggestion);
  const [check, setCheck] = useState<Check | null>(null);
  const op = useAction();
  const value = name.trim().toLowerCase();

  async function verify() {
    await op.run(async () => {
      setCheck(
        await api<Check>(`/api/servers/${serverId}/client-host/check`, {
          method: 'POST',
          json: { name: value },
        }),
      );
    });
  }

  async function save(target: string, e?: FormEvent) {
    e?.preventDefault();
    await op.run(async () => {
      await api(`/api/servers/${serverId}/client-host`, { method: 'PUT', json: { name: target } });
      await qc.invalidateQueries({ queryKey: ['client-host', serverId] });
      onDone();
    });
  }

  const checked = check?.ok === true;
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void save(value, e)}>
      <Field
        label="Имя в конфигах клиентов"
        htmlFor="ch-name"
        hint={`A-запись должна указывать на ${data.host}, проверка через публичные DNS`}
      >
        <div className="flex gap-2">
          <Input
            id="ch-name"
            className="grow font-mono"
            value={name}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setCheck(null);
            }}
            placeholder={data.suggestion}
          />
          <Button
            disabled={op.busy || !value}
            onClick={() => void verify()}
            label="Проверить"
            short="Проверить"
          >
            <SearchCheck className="size-4" />
          </Button>
        </div>
      </Field>
      {check && (
        <Alert tone={check.ok ? 'ok' : 'bad'}>
          {check.ok
            ? `${value} указывает на этот сервер (${check.addresses.join(', ')})`
            : check.error}
        </Alert>
      )}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="text-xs text-muted">
        Ссылки и конфиги на личных страницах перевыпустятся. VLESS-подписка обновится сама, а AWG,
        WDTT и OpenFlux клиентам нужно один раз взять заново, иначе после смены IP они перестанут
        работать.
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {data.clientHost && (
          <Button variant="ghost" disabled={op.busy} onClick={() => void save('')}>
            Вернуть IP
          </Button>
        )}
        <Button onClick={onDone}>Отмена</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={op.busy || !checked || value === data.clientHost}
          title={checked ? undefined : 'Имя не проверено'}
        >
          Сохранить
        </Button>
      </div>
    </form>
  );
}
