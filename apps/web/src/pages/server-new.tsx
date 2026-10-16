import {
  HostingFields,
  type HostingForm,
  emptyHostingForm,
  formToHosting,
} from '@/components/server/hosting-form';
import { InstallAgent } from '@/components/server/install-agent';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { api } from '@/lib/api';
import { countryName } from '@/lib/countries';
import { clampInt } from '@/lib/masks';
import { useServer, useServers } from '@/lib/servers';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, Radar, Wand2, X as XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface Probe {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string; ms?: number }[];
}

interface Created {
  id: string;
  registrationToken: string;
  installCommand: string;
}

/** Добавление сервера: данные и хостинг, затем установка агента (InstallAgent). */
export function ServerNewPage() {
  // имя по умолчанию - "Хостинг Страна", пока его не поправили руками
  const [customName, setCustomName] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [tags, setTags] = useState('');
  const [hosting, setHosting] = useState<HostingForm>(emptyHostingForm);
  const setH = (patch: Partial<HostingForm>) => setHosting((h) => ({ ...h, ...patch }));
  const { data: servers } = useServers();
  const name = customName ?? autoName(hosting, servers?.map((x) => x.name) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  async function runProbe() {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(
        await api<Probe>('/api/probe', {
          method: 'POST',
          json: { host: host.trim(), port: Number(sshPort) || 22 },
        }),
      );
    } catch (e) {
      setProbe({ ok: false, steps: [{ name: 'Ошибка', ok: false, detail: (e as Error).message }] });
    } finally {
      setProbing(false);
    }
  }
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<Created>('/api/servers', {
        method: 'POST',
        json: {
          name,
          host,
          sshPort: Number(sshPort) || 22,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          hosting: formToHosting(hosting),
        },
      });
      setCustomName(name); // список серверов обновится, и автоимя получило бы номер
      setCreated(res);
      await qc.invalidateQueries({ queryKey: ['servers'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="flex max-w-[760px] flex-col gap-5">
        <PageTitle>Установка агента</PageTitle>
        <Card className="flex flex-col gap-4 p-5">
          <p className="text-sm">
            Сервер <b>{name}</b> добавлен
          </p>
          <InstallAgent serverId={created.id} host={host} />
          <NextStep serverId={created.id} />
        </Card>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-[760px] flex-col gap-5">
      <PageTitle>Новый сервер</PageTitle>
      <Card className="flex flex-col gap-4 p-5">
        <div className="font-semibold">Подключение</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Имя в панели"
            htmlFor="srv-name"
            hint="если не задано, составляется из хостинга и страны"
          >
            <Input
              id="srv-name"
              value={name}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Hoster Финляндия"
              required
              maxLength={64}
            />
          </Field>
          <Field label="Теги" htmlFor="srv-tags">
            <Input
              id="srv-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="fi, hoster, vpn"
              maxLength={200}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field label="Адрес" htmlFor="srv-host">
            <Input
              id="srv-host"
              className="font-mono"
              value={host}
              onChange={(e) => setHost(e.target.value.replace(/[^a-zA-Z0-9.:-]/g, ''))}
              placeholder="203.0.113.10 или vpn.example.com"
              required
              maxLength={253}
            />
          </Field>
          <Field label="Порт SSH" htmlFor="srv-port">
            <Input
              id="srv-port"
              className="font-mono"
              value={sshPort}
              onChange={(e) => setSshPort(clampInt(e.target.value, 1, 65535))}
              inputMode="numeric"
              required
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={!host.trim() || probing}
            onClick={runProbe}
            label="Проверить доступность"
          >
            <Radar className={probing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
          <InfoTip>
            Проверка с сервера панели: DNS, порт SSH, ответ sshd. На добавление не влияет.
          </InfoTip>
        </div>
        {probe && (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg p-3 text-[13px]">
            {probe.steps.map((st) => (
              <div key={st.name} className="flex items-start gap-2">
                {st.ok ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-ok" />
                ) : (
                  <XIcon className="mt-0.5 size-4 shrink-0 text-bad" />
                )}
                <span className="w-[150px] shrink-0 text-muted">{st.name}</span>
                <span className="min-w-0 break-all">
                  {st.detail}
                  {st.ms !== undefined && <span className="text-muted"> ({st.ms}&nbsp;мс)</span>}
                </span>
              </div>
            ))}
            <div className={probe.ok ? 'mt-1 text-ok' : 'mt-1 text-bad'}>
              {probe.ok
                ? 'Сервер доступен: агент установится по SSH'
                : 'Сервер недоступен: агент можно установить только командой вручную'}
            </div>
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2.5">
          <div className="font-semibold">Хостинг</div>
          <span className="text-xs text-muted">необязательно</span>
        </div>
        <HostingFields f={hosting} set={setH} idPrefix="new" />
      </Card>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="flex items-center justify-end gap-2.5">
        <InfoTip>Пароль root, если нужен, запрашивается на следующем шаге и не хранится</InfoTip>
        <ButtonLink to="/">Отмена</ButtonLink>
        <Button type="submit" variant="primary" disabled={busy}>
          Добавить
        </Button>
      </div>
    </form>
  );
}

/** Имя из хостинга и страны ("Hoster Финляндия"); занятое получает номер: " 2", " 3". */
function autoName(h: HostingForm, taken: string[]): string {
  const base = [h.provider.trim(), countryName(h.country)].filter(Boolean).join(' ');
  if (!base) return '';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base} ${i}`;
  return name;
}

/**
 * Что дальше: агент в сети - настройка сервера в один клик (ключ панели, безопасность,
 * сервисы, клиенты); можно и просто открыть сервер.
 */
function NextStep({ serverId }: { serverId: string }) {
  const navigate = useNavigate();
  const { data: s } = useServer(serverId);
  const online = s?.status === 'online';
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!online && (
        <span className="text-xs text-muted">Настройка&nbsp;&mdash; после подключения агента</span>
      )}
      <Button onClick={() => navigate({ to: '/servers/$id', params: { id: serverId } })}>
        Открыть сервер
      </Button>
      <Button
        variant="primary"
        disabled={!online}
        onClick={() =>
          navigate({
            to: '/servers/$id/setup',
            params: { id: serverId },
            search: { backup: undefined, migrate: undefined, wipe: undefined },
          })
        }
      >
        <Wand2 className="size-4" />
        Настроить сервер
      </Button>
    </div>
  );
}
