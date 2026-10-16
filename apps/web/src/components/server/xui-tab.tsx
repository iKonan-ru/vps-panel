import { ActionPanel } from '@/components/action-output';
import { MetricCard } from '@/components/server/metric-card';
import { UninstallBlock } from '@/components/server/uninstall-block';
import { type Versions, VersionsSection } from '@/components/server/versions-section';
import { XuiClients } from '@/components/server/xui-clients';
import { type Inbound, XuiInbounds } from '@/components/server/xui-inbounds';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LinkButton } from '@/components/ui/link-button';
import { Num } from '@/components/ui/num';
import { LoadState, Placeholder } from '@/components/ui/placeholder';
import { Section } from '@/components/ui/section';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { uptime } from '@/lib/format';
import { randomToken } from '@/lib/random';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { startServiceUpdate, useUpdatesCheck } from '@/lib/service-update';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  KeyRound,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  Zap,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';

/** Компоненты блока "Версии": сама панель 3X-UI и Xray внутри неё. */
type XuiVersionKind = 'xui' | 'xray';

interface XuiInfo {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  version: string;
  db: string;
  panelPort: number;
  listen: string;
  basePath: string;
  https: boolean;
  certFile: string;
  twoFactor: boolean;
  subEnabled: boolean;
  subPort: number;
  inbounds: number;
  log: string;
  errors: string[];
}
/** server/status 3X-UI (поле obj ответа REST API). */
interface XuiServerStatus {
  cpu?: number;
  mem?: { current: number; total: number };
  uptime?: number;
  xray?: { state: string; version: string; errorMsg?: string };
  appStats?: { threads: number; mem: number; uptime: number };
}

const xuiApi = {
  info: (id: string) => api<XuiInfo>(`/api/servers/${id}/xui`),
  set: (id: string, body: Record<string, unknown>) =>
    api<{ actionId: string }>(`/api/servers/${id}/xui/set`, { method: 'POST', json: body }),
  service: (id: string, action: string) =>
    api<{ actionId: string }>(`/api/servers/${id}/xui/service`, {
      method: 'POST',
      json: { action },
    }),
  token: (id: string) => api<{ ok: boolean }>(`/api/servers/${id}/xui/token`, { method: 'POST' }),
  status: (id: string) => api<XuiServerStatus>(`/api/servers/${id}/xui/status`),
};

/** Вкладка 3X-UI: служба, Xray по API, inbound-ы и клиенты, настройки панели, обновление; журнал - по кнопке. */
export function XuiTab({ s }: { s: ServerDetail }) {
  const qc = useQueryClient();
  const online = s.status === 'online';
  const {
    data,
    error: loadError,
    isFetching,
  } = useQuery({
    queryKey: ['xui', s.id],
    queryFn: () => xuiApi.info(s.id),
    enabled: online,
    staleTime: 20_000,
  });
  const apiStatus = useQuery({
    queryKey: ['xui-api', s.id],
    queryFn: () => xuiApi.status(s.id),
    enabled: online && Boolean(data?.installed),
    staleTime: 20_000,
    retry: false,
  });
  // тот же запрос, что у блока "Inbound-ы" (общий кэш): имена inbound-ов для клиентов
  const inboundList = useQuery({
    queryKey: ['xui-inbounds', s.id],
    queryFn: () => api<Inbound[]>(`/api/servers/${s.id}/xui/inbound-list`),
    enabled: online && Boolean(data?.installed),
    staleTime: 20_000,
    retry: false,
  });
  // версии 3X-UI и Xray с последней проверки (раз в 6 часов, кнопкой, после обновления) - те же
  // обновления, что в "Обслуживании"
  const versions = useQuery({
    queryKey: ['xui-versions', s.id],
    queryFn: () => api<Versions<XuiVersionKind>>(`/api/servers/${s.id}/xui/versions`),
    enabled: online,
  });
  // после обновления версии перепроверяются сами (lib/live.ts)
  const updates = useUpdatesCheck(s.id);
  // проверка версий идёт - обновлять нельзя (решение по старым данным)
  const versionsBusy = updates.checking || versions.isFetching;
  // inVersions - вывод в блоке "Версии" (обновление), иначе - сверху вкладки
  const [action, setAction] = useState<{
    id: string;
    title: string;
    inVersions?: boolean;
  } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const op = useAction();
  // пока на сервере идёт другое действие, изменения недоступны (выпуск токена - можно)
  const lock = serverLock(s);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['xui', s.id] }),
      qc.invalidateQueries({ queryKey: ['xui-api', s.id] }),
      qc.invalidateQueries({ queryKey: ['xui-inbounds', s.id] }),
      qc.invalidateQueries({ queryKey: ['xui-clients', s.id] }),
      qc.invalidateQueries({ queryKey: ['servers'] }),
    ]);

  async function start(title: string, fn: () => Promise<{ actionId: string }>, update = false) {
    await op.run(async () => {
      const r = await fn();
      setAction({ id: r.actionId, title, inVersions: update });
    });
  }

  function updateComponent(kind: XuiVersionKind, latest: string) {
    const title = `Обновление ${kind === 'xui' ? '3X-UI' : 'Xray'} до ${latest}`;
    return start(title, () => startServiceUpdate[kind](s.id), true);
  }

  async function issueToken() {
    await op.run(async () => {
      await xuiApi.token(s.id);
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['access', s.id] })]);
    });
  }

  if (!online || loadError || !data) return <LoadState offline={!online} error={loadError} />;
  if (!data.installed)
    return <Placeholder>3X-UI не установлен: установка через каталог команд</Placeholder>;

  const svc = s.services.find((x) => x.kind === 'xui');
  const panelUrl = s.panelLinks.xui ?? svc?.panelUrl;
  const obj = apiStatus.data;
  const noToken = apiStatus.error instanceof ApiError && apiStatus.error.code === 'no-token';
  // агент 0.3.2+: xray не запущен или падает по кругу (inbound на занятом порту роняет весь xray)
  const xrayDown = svc?.details?.xrayDown === true;
  const xrayError = typeof svc?.details?.xrayError === 'string' ? svc.details.xrayError : '';

  return (
    <>
      {xrayDown && (
        <Alert tone="bad">
          Xray не работает, VLESS недоступен.
          {xrayError && <span className="block font-mono text-xs">{xrayError}</span>}
          После исправления inbound в панели 3X-UI (например, занятого порта) Xray запустится сам.
        </Alert>
      )}
      {(op.error ?? updates.error) && <Alert tone="bad">{op.error ?? updates.error}</Alert>}
      {data.errors.map((e) => (
        <Alert key={e} tone="info">
          {e}
        </Alert>
      ))}
      {action && !action.inVersions && (
        <ActionPanel title={action.title} actionId={action.id} onHide={() => setAction(null)} />
      )}

      {/* как в "Обзоре": на мобиле по две в ряд */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <MetricCard
          label="Служба x-ui"
          value={data.active ? 'Работает' : 'Остановлена'}
          tone={data.active ? 'ok' : 'bad'}
          note={
            <>
              {data.version || '?'}, база {data.db === 'postgres' ? 'PostgreSQL' : 'sqlite'}
              {!data.enabled && <span className="text-warn">, без автозапуска</span>}
            </>
          }
        />
        <MetricCard
          label="Xray"
          value={
            obj?.xray
              ? obj.xray.state === 'running'
                ? 'Работает'
                : obj.xray.state
              : noToken
                ? 'Нужен токен'
                : apiStatus.isFetching
                  ? '\u2026'
                  : 'нет данных'
          }
          tone={obj?.xray ? (obj.xray.state === 'running' ? 'ok' : 'bad') : 'muted'}
          note={
            <span title={obj?.xray?.errorMsg}>
              {[
                obj?.xray?.version ? `v${obj.xray.version}` : '',
                obj?.uptime ? `аптайм ${uptime(obj.uptime)}` : '',
                obj?.xray?.errorMsg ?? '',
              ]
                .filter(Boolean)
                .join(', ') || (noToken ? 'нужен API-токен' : '-')}
            </span>
          }
        />
        <MetricCard
          label="Панель"
          value={<span className="font-mono">{data.panelPort}</span>}
          unit={<span className="font-mono">{data.basePath}</span>}
          note={[
            data.https ? 'HTTPS' : 'без HTTPS',
            data.twoFactor ? '2FA' : 'без 2FA',
            data.listen && data.listen !== '0.0.0.0' ? `listen ${data.listen}` : '',
          ]
            .filter(Boolean)
            .join(', ')}
        />
        <MetricCard
          label="Inbound"
          value={<Num value={data.inbounds} />}
          note={`подписка 3X-UI${data.subEnabled ? `: порт ${data.subPort}` : ' выключена'}`}
        />
      </div>

      {/* панель действий: на узком экране - "Панель 3X-UI" и меню "Ещё" с подписями */}
      <ActionBar
        actions={[
          {
            key: 'panel',
            label: 'Открыть панель 3X-UI',
            icon: <ExternalLink className="size-3.5" />,
            hidden: !panelUrl,
            ...(panelUrl ? { href: panelUrl } : {}),
            node: panelUrl && (
              <LinkButton href={panelUrl} variant="primary" title={panelUrl}>
                Открыть панель 3X-UI
              </LinkButton>
            ),
            mobileNode: panelUrl && (
              <LinkButton href={panelUrl} variant="primary">
                Панель 3X-UI
              </LinkButton>
            ),
            mobile: true,
            group: 'panel',
          },
          ...(
            [
              {
                a: 'restart',
                label: 'Перезапустить 3X-UI',
                icon: <RotateCcw className="size-3.5" />,
              },
              {
                a: 'restart-xray',
                label: 'Перезапустить Xray',
                icon: <Zap className="size-3.5" />,
              },
              data.active
                ? { a: 'stop', label: 'Остановить 3X-UI', icon: <Square className="size-3.5" /> }
                : { a: 'start', label: 'Запустить 3X-UI', icon: <Play className="size-3.5" /> },
              {
                a: data.enabled ? 'disable' : 'enable',
                label: data.enabled ? 'Выключить автозапуск' : 'Включить автозапуск',
                icon: <Power className="size-3.5" />,
              },
            ] as const
          ).map(({ a, label, icon }) => ({
            key: a,
            label,
            icon,
            onClick: () => void start(label, () => xuiApi.service(s.id, a)),
            // стоп/старт и автозапуск выбраны по состоянию: пока оно перечитывается - нельзя
            disabled: op.busy || lock.busy || isFetching,
            title: lock.reason,
            group: 'service',
          })),
          {
            key: 'token',
            label: noToken ? 'Выпустить API-токен' : 'Перевыпустить API-токен',
            icon: <KeyRound className="size-3.5" />,
            onClick: () => void issueToken(),
            disabled: op.busy || lock.busy,
            title: 'Нужен для статуса Xray, inbound и клиентов панели',
            group: 'more',
          },
          {
            key: 'log',
            label: 'Журнал 3X-UI',
            icon: <ScrollText className="size-3.5" />,
            onClick: () => setShowLog(true),
            group: 'more',
          },
        ]}
        end={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={isFetching}
            onClick={refresh}
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <XuiInbounds serverId={s.id} disabled={op.busy || lock.busy} reason={lock.reason} />
      <XuiClients
        serverId={s.id}
        inbounds={inboundList.data}
        disabled={op.busy || lock.busy}
        reason={lock.reason}
      />

      <VersionsSection<XuiVersionKind>
        rows={[
          {
            kind: 'xui',
            title: '3X-UI',
            current: data.version,
            hint: 'Через x-ui update: inbound и клиенты сохранятся, панель перезапустится',
          },
          {
            kind: 'xray',
            title: 'Xray',
            current: obj?.xray?.version,
            hint: 'Подключения VLESS прервутся на несколько секунд',
          },
        ]}
        data={versions.data}
        checking={versionsBusy}
        disabled={op.busy || lock.busy || versionsBusy}
        reason={lock.reason}
        onCheck={() => void updates.check()}
        onUpdate={(kind, latest) => void updateComponent(kind, latest)}
        action={action?.inVersions ? action : null}
        onHideAction={() => setAction(null)}
      />

      <SettingsForm
        info={data}
        busy={op.busy || lock.busy}
        onSubmit={(body) => start('Настройки 3X-UI', () => xuiApi.set(s.id, body))}
      />

      <UninstallBlock
        serverId={s.id}
        kind="xui"
        title="3X-UI"
        loses="Панель, Xray и все inbound с клиентами удалятся, привязки клиентов панели снимутся"
        disabled={op.busy || lock.busy}
        reason={lock.reason}
      />

      <Dialog open={showLog} onClose={() => setShowLog(false)} title="Журнал 3X-UI" wide>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs">
          {data.log || 'Журнал пуст'}
        </pre>
      </Dialog>
    </>
  );
}

function SettingsForm({
  info,
  busy,
  onSubmit,
}: {
  info: XuiInfo;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const ask = useConfirm();
  const [port, setPort] = useState(String(info.panelPort));
  const [basePath, setBasePath] = useState(info.basePath.replace(/^\/|\/$/g, ''));
  const [listen, setListen] = useState(info.listen === '0.0.0.0' ? '' : info.listen);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reset2fa, setReset2fa] = useState(false);

  const body: Record<string, unknown> = {};
  if (Number(port) !== info.panelPort) body.port = Number(port);
  if (basePath !== info.basePath.replace(/^\/|\/$/g, '')) body.basePath = basePath;
  if ((listen || '0.0.0.0') !== (info.listen || '0.0.0.0')) body.listen = listen || '0.0.0.0';
  if (username.trim()) body.username = username.trim();
  if (password) body.password = password;
  if (reset2fa) body.resetTwoFactor = true;
  const changed = Object.keys(body).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    if (body.port || body.basePath) {
      const ok = await ask({
        title: 'Изменить порт или путь панели?',
        text: 'Старая ссылка перестанет работать, port-sync откроет новый порт',
        okLabel: 'Изменить',
      });
      if (!ok) return;
    }
    onSubmit(body);
  };

  return (
    <Section title="Настройки панели">
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Порт панели" htmlFor="xui-port">
            <Input
              id="xui-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </Field>
          <Field label="Listen IP" htmlFor="xui-listen">
            <Input
              id="xui-listen"
              value={listen}
              onChange={(e) => setListen(e.target.value)}
              placeholder="0.0.0.0"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Путь панели" htmlFor="xui-path">
          <div className="flex gap-2">
            <Input
              id="xui-path"
              value={basePath}
              onChange={(e) => setBasePath(e.target.value)}
              className="font-mono"
              pattern="[A-Za-z0-9_-]{0,64}"
            />
            <Button
              onClick={() => setBasePath(randomToken(18))}
              title="Длинный случайный путь скрывает панель от сканеров"
            >
              Сгенерировать
            </Button>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Новый логин" htmlFor="xui-user">
            <Input
              id="xui-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="без изменений"
              autoComplete="off"
            />
          </Field>
          <Field label="Новый пароль" htmlFor="xui-pass">
            <Input
              id="xui-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="задан"
              autoComplete="new-password"
            />
          </Field>
        </div>
        {info.twoFactor && (
          <Checkbox
            label="Сбросить 2FA"
            checked={reset2fa}
            onChange={(e) => setReset2fa(e.target.checked)}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">После сохранения 3X-UI перезапустится</span>
          <div className="grow" />
          <Button type="submit" variant="primary" disabled={busy || !changed}>
            Сохранить
          </Button>
        </div>
      </form>
    </Section>
  );
}
