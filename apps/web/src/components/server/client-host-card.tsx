import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
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

/**
 * "Адрес для клиентов" в "Обзоре": что стоит в конфигах людей - IP сервера или имя под
 * A-записью. С именем смена IP - правка DNS, у людей ничего не меняется.
 */
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
      info="Какой адрес сервера стоит в конфигах людей: VLESS, AWG, WDTT, OpenFlux. С именем (A-запись в DNS на этот сервер) смена IP у хостера - правка одной записи в DNS, конфиги у людей не меняются. С IP - после смены IP выданные AWG, WDTT и OpenFlux перестанут работать."
      extra={<Chip tone={named ? 'ok' : 'muted'}>{named ? 'имя' : 'IP'}</Chip>}
      actions={
        <Button size="sm" onClick={() => setOpen(true)} label="Изменить">
          <Pencil className="size-3.5" />
        </Button>
      }
    >
      <div className="px-4 py-3 text-[13px]">
        <span className="font-mono">{data.clientHost || data.host}</span>
        {named && <span className="text-muted"> - указывает на {data.host}</span>}
        {!named && (
          <div className="mt-1 text-xs text-muted">
            Лучше имя: например <span className="font-mono">{data.suggestion}</span> (A-запись на{' '}
            {data.host}).
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const value = name.trim().toLowerCase();

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      setCheck(
        await api<Check>(`/api/servers/${serverId}/client-host/check`, {
          method: 'POST',
          json: { name: value },
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(target: string, e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/servers/${serverId}/client-host`, { method: 'PUT', json: { name: target } });
      await qc.invalidateQueries({ queryKey: ['client-host', serverId] });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const checked = check?.ok === true;
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void save(value, e)}>
      <Field
        label="Имя сервера в конфигах людей"
        htmlFor="ch-name"
        hint={`A-запись имени должна указывать на ${data.host}; проверка - через публичные DNS`}
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
            disabled={busy || !value}
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
            ? `${value} указывает на ${check.addresses.join(', ')} - этот сервер`
            : check.error}
        </Alert>
      )}
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="text-xs text-muted">
        После сохранения панель перевыпустит ссылки и конфиги на личных страницах. VLESS-подписка
        обновится у людей сама; AWG, WDTT и OpenFlux с прежним адресом работают, пока не сменился
        IP, - чтобы смена IP прошла незаметно, людям нужно один раз заново взять их с личной
        страницы.
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {data.clientHost && (
          <Button variant="ghost" disabled={busy} onClick={() => void save('')}>
            Вернуть IP
          </Button>
        )}
        <Button onClick={onDone}>Отмена</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !checked || value === data.clientHost}
          title={checked ? undefined : 'Сначала проверь имя'}
        >
          Сохранить
        </Button>
      </div>
    </form>
  );
}
