import { ActionPanel } from '@/components/action-output';
import { MetricCard } from '@/components/server/metric-card';
import { UninstallBlock } from '@/components/server/uninstall-block';
import { type Versions, VersionsSection } from '@/components/server/versions-section';
import { XuiClients } from '@/components/server/xui-clients';
import { XuiInbounds } from '@/components/server/xui-inbounds';
import { type XuiVersionKind, xuiApi } from '@/components/server/xui-model';
import { SettingsForm } from '@/components/server/xui-settings';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { LinkButton } from '@/components/ui/link-button';
import { Num } from '@/components/ui/num';
import { LoadState, Placeholder } from '@/components/ui/placeholder';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { uptime } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { startServiceUpdate, useUpdatesCheck } from '@/lib/service-update';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { XuiInboundRow } from '@vps/protocol';
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
import { useState } from 'react';

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
    queryFn: () => api<XuiInboundRow[]>(`/api/servers/${s.id}/xui/inbound-list`),
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
  // xray не запущен или падает по кругу (inbound на занятом порту роняет весь xray)
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
