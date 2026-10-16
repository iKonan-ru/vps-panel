import { ActionPanel } from '@/components/action-output';
import { OwnerLink, useOwners } from '@/components/owner-link';
import { UninstallBlock } from '@/components/server/uninstall-block';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LinkButton } from '@/components/ui/link-button';
import { LoadState } from '@/components/ui/placeholder';
import { QrCode } from '@/components/ui/qr-code';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerDetail } from '@vps/protocol';
import {
  Download,
  FileText,
  Play,
  Plus,
  QrCode as QrCodeIcon,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface OfChannel {
  channel: string;
  port: number;
  state: string;
  enabled: boolean;
  since: string;
  memoryMb: number;
  transports: { name: string; type: string; priority: number }[];
}
interface OfStatus {
  installed: boolean;
  core: string;
  autoupdate: boolean;
  channels: OfChannel[];
}

const transportTitle: Record<string, string> = {
  vyandex: 'Яндекс Документ',
  yandex: 'Яндекс Документ',
  mailru: 'Mail.ru Документ',
  cupsonline: 'cups.online',
  boards: 'Яндекс Доска',
  direct: 'напрямую',
};

/** Вкладка OpenFlux: каналы ноды (ключ и транспорты); пользователей и статистики у ноды нет. */
export function OpenfluxTab({ s }: { s: ServerDetail }) {
  const owner = useOwners(s.id);
  const qc = useQueryClient();
  const ask = useConfirm();
  const online = s.status === 'online';
  const lock = serverLock(s);
  const { data, error } = useQuery({
    queryKey: ['openflux', s.id],
    queryFn: () => api<OfStatus>(`/api/servers/${s.id}/openflux`),
    enabled: online,
    refetchInterval: 60_000,
  });
  const [action, setAction] = useState<{ id: string; title: string } | null>(null);
  const [add, setAdd] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['openflux', s.id] });
  const exec = (json: Record<string, unknown>) =>
    api<{ actionId?: string }>(`/api/servers/${s.id}/openflux/exec`, { method: 'POST', json });
  // пока идёт операция, остальные кнопки вкладки недоступны (двойной тап, соседний канал)
  const op = useAction();
  async function call(title: string, json: Record<string, unknown>) {
    await op.run(async () => {
      const r = await exec(json);
      if (r.actionId) setAction({ id: r.actionId, title });
      await refresh();
    });
  }
  const blocked = lock.busy || op.busy;

  if (!online || error || !data) return <LoadState offline={!online} error={error} />;

  return (
    <>
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      {action && (
        <ActionPanel title={action.title} actionId={action.id} onHide={() => setAction(null)} />
      )}
      {data.channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3 text-[13px]">
          <span>
            Ядро <span className="font-mono">{data.core || '?'}</span>
          </span>
          <Switch
            checked={data.autoupdate}
            disabled={blocked}
            label="Автообновление ядра"
            onChange={() =>
              void call('OpenFlux: автообновление', {
                op: data.autoupdate ? 'autoupdate-off' : 'autoupdate-on',
              })
            }
          />
          <div className="grow" />
          <Button
            size="sm"
            disabled={blocked}
            title={lock.reason ?? 'Каналы перезапустятся'}
            onClick={() => void call('OpenFlux: обновление ядра', { op: 'update' })}
            label="Обновить ядро"
            short="Обновить ядро"
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      )}
      <Section
        title="Каналы OpenFlux"
        info="Канал: ключ и набор транспортов, ссылка канала содержит ключ. На каждое одновременно работающее устройство нужен свой канал."
        extra={<Chip>{data.channels.length}</Chip>}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={blocked}
            title={lock.reason}
            onClick={() => setAdd(true)}
            label="Новый канал"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {data.channels.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">
            Каналов нет. &laquo;Новый канал&raquo; установит OpenFlux, если его ещё нет.
          </div>
        )}
        {data.channels.map((c) => {
          const active = c.state === 'active';
          const own = owner('openflux', c.channel);
          return (
            <div
              key={c.channel}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-mono font-medium">{c.channel}</span>
                  {active ? (
                    <Chip tone="ok">работает</Chip>
                  ) : c.enabled ? (
                    <Chip tone="bad">{c.state}</Chip>
                  ) : (
                    <Chip tone="muted">выключен</Chip>
                  )}
                  {own ? (
                    <OwnerLink owner={own} />
                  ) : (
                    c.channel.startsWith('vp-') && <Chip>клиент панели</Chip>
                  )}
                  <span className="font-mono text-xs text-muted">{c.port}/tcp</span>
                </div>
                <div className="text-xs text-muted">
                  {[...c.transports]
                    .sort((a, b) => b.priority - a.priority)
                    .map((t) => transportTitle[t.type] ?? t.type)
                    .join(', ')}
                  {active && c.since && `, работает ${ago(c.since).replace(' назад', '')}`}
                  {c.memoryMb > 0 && `, ${c.memoryMb}\u00a0МБ`}
                </div>
              </div>
              <ActionBar
                dense
                actions={[
                  {
                    key: 'link',
                    label: 'Ссылка',
                    icon: <QrCodeIcon className="size-3.5" />,
                    mobile: true,
                    onClick: () =>
                      op.run(async () => {
                        const r = await api<{ link: string }>(
                          `/api/servers/${s.id}/openflux/link`,
                          { method: 'POST', json: { channel: c.channel } },
                        );
                        setLink(r.link);
                      }),
                  },
                  {
                    key: 'log',
                    label: 'Журнал канала',
                    icon: <FileText className="size-3.5" />,
                    onClick: () =>
                      op.run(async () => {
                        const r = await api<{ text: string }>(
                          `/api/servers/${s.id}/openflux/logs`,
                          { method: 'POST', json: { channel: c.channel, lines: 300 } },
                        );
                        setLogs(r.text || 'Журнал пуст');
                      }),
                  },
                  {
                    key: 'restart',
                    label: 'Перезапустить канал',
                    icon: <RotateCcw className="size-3.5" />,
                    disabled: blocked,
                    onClick: () =>
                      void call('OpenFlux: перезапуск', { op: 'restart', channel: c.channel }),
                  },
                  {
                    key: 'toggle',
                    label: active ? 'Остановить канал' : 'Запустить канал',
                    icon: active ? <Square className="size-3.5" /> : <Play className="size-3.5" />,
                    disabled: blocked,
                    onClick: () =>
                      void call(active ? 'OpenFlux: остановка' : 'OpenFlux: запуск', {
                        op: active ? 'stop' : 'start',
                        channel: c.channel,
                      }),
                  },
                  {
                    key: 'remove',
                    label: 'Удалить канал',
                    icon: <Trash2 className="size-3.5" />,
                    variant: 'danger',
                    group: 'danger',
                    disabled: blocked,
                    onClick: async () => {
                      const last = data.channels.length === 1;
                      const ok = await ask({
                        title: `Удалить канал \u00ab${c.channel}\u00bb?`,
                        text: last
                          ? 'Последний канал: вместе с ним удалятся ядро OpenFlux и служба обновлений. Приложения с этим каналом перестанут подключаться.'
                          : 'Приложения с этим каналом перестанут подключаться',
                        okLabel: 'Удалить',
                        danger: true,
                      });
                      if (ok)
                        await call(`OpenFlux: удаление ${c.channel}`, {
                          op: 'remove',
                          channel: c.channel,
                        });
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
        kind="openflux"
        title="OpenFlux"
        loses="Все каналы удалятся, их ссылки в приложениях перестанут работать"
        disabled={blocked}
        reason={lock.reason}
      />

      <Dialog open={add} onClose={() => setAdd(false)} title="Новый канал OpenFlux">
        <ChannelForm
          onSubmit={async (v) => {
            const r = await exec({ op: 'create', ...v });
            setAdd(false);
            if (r.actionId) setAction({ id: r.actionId, title: 'OpenFlux: новый канал' });
          }}
        />
      </Dialog>
      <Dialog open={link !== null} onClose={() => setLink(null)} title="Ссылка канала">
        {link && (
          <div className="flex flex-col gap-3">
            <Alert tone="info">
              В ссылке ключ канала: её стоит передавать только тому, кто будет подключаться
            </Alert>
            <QrCode text={link} alt="QR-код ссылки канала OpenFlux" level="L" />
            <LinkButton href={link} variant="primary" size="md" wide copyTitle="Скопировать ссылку">
              Открыть в OpenFlux
            </LinkButton>
          </div>
        )}
      </Dialog>
      <Dialog open={logs !== null} onClose={() => setLogs(null)} title="Журнал канала" wide>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs">
          {logs}
        </pre>
        <div className="mt-2 text-xs text-muted">Ссылки на документы и ключи скрыты</div>
      </Dialog>
    </>
  );
}

function ChannelForm({
  onSubmit,
}: {
  onSubmit: (v: { vyandex: string; mailru: string; cupsonline: string }) => Promise<void>;
}) {
  const [vyandex, setVyandex] = useState('');
  const [mailru, setMailru] = useState('');
  const [cups, setCups] = useState(true);
  const save = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    void save.run(() =>
      onSubmit({ vyandex: vyandex.trim(), mailru: mailru.trim(), cupsonline: cups ? 'auto' : '' }),
    );
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="text-[13px] text-muted">
        Прямое подключение есть всегда. Документы служат запасными транспортами: нужен документ с
        редактированием по ссылке, один документ на канал.
      </div>
      <Checkbox checked={cups} onChange={() => setCups(!cups)} label="Комнаты cups.online" />
      <Field label="Яндекс Документ (необязательно)" htmlFor="of-ya">
        <Input
          id="of-ya"
          value={vyandex}
          onChange={(e) => setVyandex(e.target.value)}
          placeholder="https://docs.yandex.ru/edit/d/..."
        />
      </Field>
      <Field label="Mail.ru Документ (необязательно)" htmlFor="of-mr">
        <Input
          id="of-mr"
          value={mailru}
          onChange={(e) => setMailru(e.target.value)}
          placeholder="https://cloud.mail.ru/public/..."
        />
      </Field>
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <Button type="submit" variant="primary" disabled={save.busy}>
        Создать канал
      </Button>
    </form>
  );
}
