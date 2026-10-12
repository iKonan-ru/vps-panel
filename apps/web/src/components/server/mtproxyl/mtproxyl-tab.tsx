import { ActionPanel } from '@/components/action-output';
import { useOwners } from '@/components/owner-link';
import { MetricCard } from '@/components/server/metric-card';
import { type MtUser, mtApi } from '@/components/server/mtproxyl/model';
import { AddForm, UserInfo, UserLinks } from '@/components/server/mtproxyl/user-dialogs';
import {
  EngineForm,
  type MtVersionKind,
  type MtVersions,
} from '@/components/server/mtproxyl/versions';
import { VersionsSection } from '@/components/server/versions-section';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { LinkButton } from '@/components/ui/link-button';
import { Num } from '@/components/ui/num';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes, uptime } from '@/lib/format';
import { reachLevel, reachTone } from '@/lib/reach';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Layers,
  MonitorCog,
  Plus,
  RefreshCw,
  RotateCcw,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';

/**
 * Вкладка MTProxyL: состояние прокси, обновление и перезапуск, пользователи со ссылками,
 * переход в веб-панель. Тонкие настройки (лимиты, nft, ротация) - в самой панели MTProxyL.
 */
export function MtproxylTab({ s }: { s: ServerDetail }) {
  const owner = useOwners(s.id);
  const ask = useConfirm();
  const qc = useQueryClient();
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны (ссылки копировать можно)
  const lock = serverLock(s);
  const {
    data,
    error: loadError,
    isFetching,
  } = useQuery({
    queryKey: ['mtproxyl', s.id],
    queryFn: () => mtApi.status(s.id),
    enabled: online,
    staleTime: 20_000,
  });
  // recheck - после действия перепроверить версии (это было обновление); inVersions - вывод
  // внутри блока "Версии" (обновления и движок), иначе - сверху вкладки
  const [action, setAction] = useState<{
    id: string;
    title: string;
    recheck?: boolean;
    inVersions?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // пользователь, чьё окно со ссылками и QR открыто
  const [user, setUser] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  // через поддомен панели, если агент умеет туннель; иначе прямой адрес
  const panelUrl =
    s.panelLinks.mtproxyl ?? s.inventory?.services.find((sv) => sv.kind === 'mtproxyl')?.panelUrl;
  // версии с последней проверки обновлений (раз в 6 часов, кнопкой, после обновления)
  const versions = useQuery({
    queryKey: ['mtproxyl-versions', s.id],
    queryFn: () => api<MtVersions>(`/api/servers/${s.id}/mtproxyl/versions`),
    enabled: online,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['mtproxyl', s.id] });
  // проверка версий идёт - обновлять и менять версию нельзя (решение по старым данным)
  const versionsBusy = checking || versions.isFetching;

  /** Проверить обновления сервера сейчас; итог виден и здесь, и в "Обзоре", и в списке. */
  async function recheck() {
    setChecking(true);
    setError(null);
    try {
      await api(`/api/servers/${s.id}/updates/check`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // кнопки версий - только после свежего списка: иначе "Обновить" по старым данным
      await qc.invalidateQueries({ queryKey: ['mtproxyl-versions', s.id] });
      await qc.invalidateQueries({ queryKey: ['service-updates'] });
      await qc.invalidateQueries({ queryKey: ['service-updates-all'] });
      setChecking(false);
    }
  }

  /** Короткая операция: результат сразу; длинная: блок с выводом, обновление по завершении. */
  async function run(
    title: string,
    op: string,
    args: Record<string, string> = {},
    recheckAfter = false,
    inVersions = false,
  ) {
    setBusy(true);
    setError(null);
    try {
      const r = await mtApi.exec(s.id, op, args);
      if (r.actionId) setAction({ id: r.actionId, title, recheck: recheckAfter, inVersions });
      else await refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Сменить версию движка telemt: только готовый образ docker или бинарник (без сборки). */
  async function changeEngine(tag: string) {
    const ok = await ask({
      title: `Поставить движок telemt ${tag}?`,
      text: 'Скачается готовый образ docker или бинарник, затем прокси перезапустится: подключения пользователей прервутся на несколько секунд.',
      okLabel: 'Поставить',
    });
    if (!ok) return;
    setEngineOpen(false);
    await run(`Движок MTProxyL: версия ${tag}`, 'engine.update', { version: tag }, false, true);
  }

  function updateComponent(kind: MtVersionKind, latest: string) {
    if (kind === 'mtproxyl')
      return run(`Обновление MTProxyL до ${latest}`, 'update', {}, true, true);
    // веб-панель - до последнего релиза сразу, без подтверждения: установщик берёт настройки из
    // её конфига, прокси и пользователи не затрагиваются
    return run('Обновление панели MTProxyL', 'panel.update', {}, true, true);
  }

  /** Включить или выключить пользователя. */
  function toggleUser(u: MtUser) {
    return run('', u.enabled ? 'secret.disable' : 'secret.enable', { label: u.label });
  }

  /** Удалить пользователя после подтверждения; true - удалён. */
  async function removeUser(u: MtUser) {
    const ok = await ask({
      title: `Удалить пользователя ${u.label}?`,
      text: 'Его ссылки перестанут работать.',
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return false;
    return (await run('', 'secret.remove', { label: u.label })) !== null;
  }

  if (!online) return <Card className="p-8 text-[13px] text-muted">Агент не на связи.</Card>;
  if (loadError) return <Alert tone="bad">{loadError.message}</Alert>;
  if (!data) return <Card className="p-8 text-[13px] text-muted">Опрашиваю mtproxyl...</Card>;
  if (!data.installed)
    return (
      <Card className="p-8 text-[13px] text-muted">
        MTProxyL на сервере не найден. Установить можно командой из каталога.
      </Card>
    );

  const st = data.status;
  // "Доступность из России" - проверка самого MTProxyL (зонды Globalping), агент кладёт её итог
  // в снимок
  const reach = s.services.find((x) => x.kind === 'mtproxyl')?.details?.ruReach as
    | { percent: number; ok: number; total: number; checkedAt: string; error?: string }
    | undefined;
  const trafficByUser = new Map((data.traffic?.users ?? []).map((u) => [u.user, u]));
  const openUser = data.secrets?.find((u) => u.label === user);
  const panelInstalled = Boolean(panelUrl) || /running|active|работает/i.test(data.panel);
  // "mtproxyl panel status" печатает "Состояние: работает (v1.2.12)"
  const panelVersion = /\((v?[0-9][^)\s]*)\)/.exec(data.panel)?.[1];
  const proxyNote = `v${st?.version ?? '?'}, режим ${st?.mode ?? '?'}${
    st?.uptime ? `, аптайм ${uptime(st.uptime)}` : ''
  }`;

  return (
    <>
      {error && <Alert tone="bad">{error}</Alert>}
      {data.errors.map((e) => (
        <Alert key={e} tone="info">
          {e}
        </Alert>
      ))}
      {action && !action.inVersions && (
        <ActionPanel
          title={action.title}
          actionId={action.id}
          onHide={() => setAction(null)}
          onFinished={() => {
            void refresh();
            if (action.recheck) void recheck();
          }}
        />
      )}

      {/* как в "Обзоре": на мобиле по две в ряд */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-5">
        <MetricCard
          label="Прокси"
          value={st?.status === 'running' ? 'Работает' : (st?.status ?? 'нет данных')}
          tone={st?.status === 'running' ? 'ok' : st?.status ? 'bad' : 'muted'}
          note={<span title={proxyNote}>{proxyNote}</span>}
        />
        <MetricCard
          label="Порт и FakeTLS"
          value={<span className="font-mono">{st?.port ?? '-'}</span>}
          note={<span title={st?.domain}>{st?.domain ?? '-'}</span>}
        />
        <MetricCard
          label="Подключения"
          value={<Num value={st?.connections ?? 0} />}
          note={`уникальных IP: ${st?.unique_ips ?? 0}`}
        />
        <MetricCard
          label="Из России"
          value={reach ? `${reach.percent}%` : 'нет данных'}
          tone={reach ? reachTone[reachLevel(reach.percent) ?? 'bad'] : 'muted'}
          note={
            reach
              ? reach.error
                ? `проверка не удалась: ${reach.error}`
                : `дошли ${reach.ok} из ${reach.total} зондов, ${ago(reach.checkedAt)}`
              : 'проверок MTProxyL ещё не было'
          }
        />
        <MetricCard
          label="Трафик"
          value={<Num value={st?.traffic_total ?? 0} format={bytes} />}
          note={`вход ${bytes(st?.traffic_in ?? 0)}, выход ${bytes(st?.traffic_out ?? 0)}`}
        />
      </div>

      {/* панель действий: на узком экране - "Панель MTProxyL" и меню "Ещё" с подписями;
          обновления версий - в блоке "Версии" */}
      <ActionBar
        actions={[
          {
            key: 'panel',
            label: 'Открыть панель MTProxyL',
            icon: <ExternalLink className="size-3.5" />,
            hidden: !panelUrl,
            ...(panelUrl ? { href: panelUrl } : {}),
            node: panelUrl && (
              <LinkButton
                href={panelUrl}
                variant="primary"
                title={panelVersion ? `Открыть панель MTProxyL (${panelVersion})` : panelUrl}
              >
                Открыть панель MTProxyL
              </LinkButton>
            ),
            mobileNode: panelUrl && (
              <LinkButton href={panelUrl} variant="primary">
                Панель MTProxyL
              </LinkButton>
            ),
            mobile: true,
            group: 'panel',
          },
          {
            key: 'install-panel',
            label: 'Установить панель',
            icon: <Plus className="size-3.5" />,
            hidden: Boolean(panelUrl),
            node: (
              <ButtonLink
                to="/commands/$id"
                params={{ id: 'mtproxyl' }}
                search={{ server: s.id, run: undefined, tab: undefined }}
                size="sm"
                title="Панель не найдена: установить командой из каталога"
              >
                <Plus className="size-3.5" />
                Установить панель
              </ButtonLink>
            ),
            mobile: true,
            group: 'panel',
          },
          {
            key: 'restart',
            label: 'Перезапустить прокси',
            icon: <RotateCcw className="size-3.5" />,
            onClick: () => void run('Перезапуск MTProxyL', 'restart'),
            disabled: busy || lock.busy,
            title: lock.reason,
            group: 'service',
          },
          {
            key: 'panel-restart',
            label: 'Перезапустить панель MTProxyL',
            icon: <MonitorCog className="size-3.5" />,
            hidden: !panelUrl || !panelInstalled,
            onClick: () => void run('Перезапуск панели', 'panel.restart'),
            disabled: busy || lock.busy,
            title: lock.reason,
            group: 'service',
          },
        ]}
        end={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={isFetching}
            onClick={() => void refresh()}
            title="Обновить данные вкладки"
            aria-label="Обновить данные вкладки"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <Section
        title="Пользователи"
        info="Лимиты, ротация секретов, настройки прокси и nft - в панели MTProxyL; сертификат панели - во вкладке Сертификаты."
        extra={<Chip>{data.secrets?.length ?? 0}</Chip>}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={busy || lock.busy}
            title={lock.reason}
            onClick={() => setAddOpen(true)}
            label="Добавить"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {/* компактный список: точка состояния и имя; подробности и управление - в окне */}
        {(data.secrets ?? []).length === 0 ? (
          <div className="px-4 py-4 text-center text-[13px] text-muted">Пользователей нет</div>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
            {(data.secrets ?? []).map((u) => {
              const panel = owner('mtproxyl', u.label);
              return (
                <button
                  key={u.label}
                  type="button"
                  title={`${u.enabled ? 'включён' : 'выключен'}${panel ? `, клиент панели ${panel.client}` : ''}: подробности, ссылки и QR-код`}
                  onClick={() => setUser(u.label)}
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent"
                >
                  <span
                    aria-label={u.enabled ? 'включён' : 'выключен'}
                    className={cn(
                      'size-2.5 shrink-0 rounded-full',
                      u.enabled ? 'bg-ok' : 'bg-muted',
                    )}
                  />
                  <span className="min-w-0 grow truncate font-mono text-[13px]">{u.label}</span>
                  {panel && (
                    <UserRound
                      className="size-3.5 shrink-0 text-accent"
                      aria-label={`клиент панели ${panel.client}`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <VersionsSection<MtVersionKind>
        rows={[
          { kind: 'mtproxyl', title: 'MTProxyL' },
          ...(panelInstalled ? [{ kind: 'mtproxyl-panel' as const, title: 'Веб-панель' }] : []),
        ]}
        data={versions.data}
        checking={versionsBusy}
        disabled={busy || lock.busy || versionsBusy}
        reason={lock.reason}
        onCheck={() => void recheck()}
        onUpdate={(kind, latest) => void updateComponent(kind, latest)}
        action={action?.inVersions ? action : null}
        onHideAction={() => setAction(null)}
        onActionFinished={() => {
          void refresh();
          if (action?.recheck) void recheck();
        }}
      >
        {/* движок telemt - не обновление: версия меняется по желанию (EngineForm) */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 grow">
            <div className="font-medium">Движок telemt</div>
            <div className="text-xs text-muted">установлена {data.engine || '?'}</div>
          </div>
          <Button
            size="sm"
            disabled={busy || lock.busy || versionsBusy}
            title={lock.reason}
            onClick={() => setEngineOpen(true)}
          >
            <Layers className="size-3.5" />
            Сменить<span className="hidden md:inline"> версию</span>
          </Button>
        </div>
      </VersionsSection>

      <Dialog open={engineOpen} onClose={() => setEngineOpen(false)} title="Версия движка telemt">
        {engineOpen && (
          <EngineForm
            serverId={s.id}
            disabled={busy || lock.busy}
            reason={lock.reason}
            onInstall={(tag) => void changeEngine(tag)}
          />
        )}
      </Dialog>

      <Dialog
        open={user !== null}
        onClose={() => setUser(null)}
        title={`Пользователь ${user ?? ''}`}
      >
        {openUser && (
          <UserInfo
            u={openUser}
            owner={owner('mtproxyl', openUser.label)}
            traffic={trafficByUser.get(openUser.label)}
            disabled={busy || lock.busy}
            reason={lock.reason}
            onToggle={() => void toggleUser(openUser)}
            onRemove={() => void removeUser(openUser).then((removed) => removed && setUser(null))}
            onRename={async (name) => {
              // секрет тот же - ссылки пользователя не меняются; окно переходит на новое имя.
              // Пока идёт - остальные действия вкладки заблокированы (busy)
              setBusy(true);
              try {
                await mtApi.exec(s.id, 'secret.rename', { label: openUser.label, new: name });
                setUser(name);
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {user && <UserLinks serverId={s.id} label={user} />}
        <div className="flex justify-end">
          <Button onClick={() => setUser(null)}>Закрыть</Button>
        </div>
      </Dialog>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Новый пользователь">
        <AddForm
          busy={busy || lock.busy}
          onSubmit={async (label, secret) => {
            const r = await run('', 'secret.add', secret ? { label, secret } : { label });
            if (r) setAddOpen(false);
          }}
        />
      </Dialog>
    </>
  );
}
