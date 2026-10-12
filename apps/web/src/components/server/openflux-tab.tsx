import { ActionPanel } from '@/components/action-output';
import { OwnerLink, useOwners } from '@/components/owner-link';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LinkButton } from '@/components/ui/link-button';
import { QrCode } from '@/components/ui/qr-code';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Транспорты OpenFlux по-человечески. */
const transportTitle: Record<string, string> = {
  vyandex: 'Яндекс Документ',
  yandex: 'Яндекс Документ',
  mailru: 'Mail.ru Документ',
  cupsonline: 'cups.online',
  boards: 'Яндекс Доска',
  direct: 'напрямую',
};

/**
 * Вкладка OpenFlux: каналы выходной ноды. Пользователей у OpenFlux нет:
 * канал - ключ и набор транспортов, ссылка openflux:// - профиль для приложения (в ней ключ).
 * Статистики у ноды нет, только журнал.
 */
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
  const [err, setErr] = useState<string | null>(null);
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
    setErr(null);
    await op.run(async () => {
      try {
        const r = await exec(json);
        if (r.actionId) setAction({ id: r.actionId, title });
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }
  const blocked = lock.busy || op.busy;

  if (!online) return <Card className="p-8 text-[13px] text-muted">Агент не на связи.</Card>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <Card className="p-8 text-[13px] text-muted">Опрашиваю OpenFlux...</Card>;

  return (
    <>
      {err && <Alert tone="bad">{err}</Alert>}
      {action && (
        <ActionPanel
          title={action.title}
          actionId={action.id}
          onHide={() => setAction(null)}
          onFinished={() => void refresh()}
        />
      )}
      {data.channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3 text-[13px]">
          <span>
            Ядро <span className="font-mono">{data.core || '?'}</span>
          </span>
          <Switch
            checked={data.autoupdate}
            disabled={blocked}
            label="автообновление ядра (раз в 6 часов)"
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
            title={lock.reason ?? 'Поставить новейшее ядро node-v* и перезапустить каналы'}
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
        info="Канал - ключ и набор транспортов (Яндекс Документ, Mail.ru Документ, cups.online и всегда прямое подключение). Пользователей у OpenFlux нет: ссылка канала - профиль для приложения, в ней ключ. По документации OpenFlux на каждое одновременно работающее устройство нужен свой канал."
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
            Каналов нет. "Новый канал" поставит OpenFlux (если его ещё нет) и канал с прямым
            подключением и комнатами cups.online; документы Яндекса и Mail.ru - по желанию.
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
                  {active && c.since && ` - работает ${ago(c.since).replace(' назад', '')}`}
                  {c.memoryMb > 0 && `, ${c.memoryMb} МБ`}
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
                    onClick: async () => {
                      setErr(null);
                      try {
                        const r = await api<{ link: string }>(
                          `/api/servers/${s.id}/openflux/link`,
                          { method: 'POST', json: { channel: c.channel } },
                        );
                        setLink(r.link);
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    },
                  },
                  {
                    key: 'log',
                    label: 'Журнал канала',
                    icon: <FileText className="size-3.5" />,
                    onClick: async () => {
                      setErr(null);
                      try {
                        const r = await api<{ text: string }>(
                          `/api/servers/${s.id}/openflux/logs`,
                          { method: 'POST', json: { channel: c.channel, lines: 300 } },
                        );
                        setLogs(r.text || 'Журнал пуст');
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    },
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
                        title: `Удалить канал ${c.channel}?`,
                        text: last
                          ? 'Это последний канал: установщик OpenFlux удалит вместе с ним и ядро, и службу обновлений. Приложения с этим каналом перестанут подключаться.'
                          : 'Приложения с этим каналом перестанут подключаться, ключ и порт удаляются.',
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
              В ссылке - ключ канала: передавайте её только тому, кто будет подключаться. В
              приложении OpenFlux - добавить профиль по ссылке или QR-коду.
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
        <div className="mt-2 text-xs text-muted">Ссылки на документы и ключи скрыты.</div>
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
        Имя, ключ и порт канала сервер придумает сам; прямое подключение есть всегда. Документы -
        запасные транспорты: документ с редактированием по ссылке из своего аккаунта, один документ
        - один канал.
      </div>
      <Checkbox
        checked={cups}
        onChange={() => setCups(!cups)}
        label="Комнаты cups.online (создаст сервер)"
      />
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
        {save.busy ? 'Создаю...' : 'Создать канал'}
      </Button>
    </form>
  );
}
