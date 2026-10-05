import { ActionPanel } from '@/components/action-output';
import { useOwners } from '@/components/owner-link';
import { MetricCard } from '@/components/server/metric-card';
import { type MtUser, mtApi } from '@/components/server/mtproxyl/model';
import { AddForm, UserInfo, UserLinks } from '@/components/server/mtproxyl/user-dialogs';
import {
  EngineForm,
  type MtVersionKind,
  type MtVersions,
  VersionsSection,
} from '@/components/server/mtproxyl/versions';
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
import { bytes, uptime } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { updateConfirm } from '@/lib/service-update';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorCog, Plus, RefreshCw, RotateCcw, UserRound } from 'lucide-react';
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
  // recheck - после действия перепроверить версии (это было обновление)
  const [action, setAction] = useState<{ id: string; title: string; recheck?: boolean } | null>(
    null,
  );
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

  /** Проверить обновления сервера сейчас; итог виден и здесь, и в "Обзоре", и в списке. */
  async function recheck() {
    setChecking(true);
    setError(null);
    try {
      await api(`/api/servers/${s.id}/updates/check`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
      await qc.invalidateQueries({ queryKey: ['mtproxyl-versions', s.id] });
      await qc.invalidateQueries({ queryKey: ['service-updates'] });
      await qc.invalidateQueries({ queryKey: ['service-updates-all'] });
    }
  }

  /** Короткая операция: результат сразу; длинная: блок с выводом, обновление по завершении. */
  async function run(
    title: string,
    op: string,
    args: Record<string, string> = {},
    recheckAfter = false,
  ) {
    setBusy(true);
    setError(null);
    try {
      const r = await mtApi.exec(s.id, op, args);
      if (r.actionId) setAction({ id: r.actionId, title, recheck: recheckAfter });
      else await refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Обновить веб-панель до последнего релиза: установщик берёт настройки из её конфига. */
  async function updatePanel() {
    const confirm = updateConfirm['mtproxyl-panel'];
    if (!confirm || (await ask(confirm)))
      await run('Обновление панели MTProxyL', 'panel.update', {}, true);
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
    await run(`Движок MTProxyL: версия ${tag}`, 'engine.update', { version: tag });
  }

  function updateComponent(kind: MtVersionKind, latest: string) {
    if (kind === 'mtproxyl') return run(`Обновление MTProxyL до ${latest}`, 'update', {}, true);
    return updatePanel();
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
      {action && (
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
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
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
          label="Трафик"
          value={<Num value={st?.traffic_total ?? 0} format={bytes} />}
          note={`вход ${bytes(st?.traffic_in ?? 0)}, выход ${bytes(st?.traffic_out ?? 0)}`}
        />
      </div>

      {/* Группы: прокси (перезапуск), панель MTProxyL (открыть и перезапуск), справа - обновление
          данных вкладки; обновления версий - в блоке "Версии". На мобиле подписей нет. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || lock.busy}
          title={lock.reason}
          onClick={() => run('Перезапуск MTProxyL', 'restart')}
          label="Перезапустить прокси"
        >
          <RotateCcw className="size-3.5" />
        </Button>
        <span className="mx-1 hidden h-5 w-px bg-border md:block" />
        {panelUrl ? (
          <>
            <LinkButton
              href={panelUrl}
              variant="primary"
              label="Открыть панель MTProxyL"
              title={panelVersion ? `Открыть панель MTProxyL (${panelVersion})` : panelUrl}
            />
            {panelInstalled && (
              <Button
                size="sm"
                disabled={busy || lock.busy}
                title={lock.reason ?? 'Перезапустить панель MTProxyL'}
                aria-label="Перезапустить панель MTProxyL"
                onClick={() => void run('Перезапуск панели', 'panel.restart')}
              >
                <MonitorCog className="size-3.5" />
              </Button>
            )}
          </>
        ) : (
          <ButtonLink
            to="/commands/$id"
            params={{ id: 'mtproxyl' }}
            search={{ server: s.id, run: undefined, tab: undefined }}
            size="sm"
            title="Панель не найдена: установить командой из каталога"
            label="Установить панель"
          >
            <Plus className="size-3.5" />
          </ButtonLink>
        )}
        <div className="grow" />
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={isFetching}
          onClick={() => void refresh()}
          title="Обновить данные"
          aria-label="Обновить данные"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>

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

      <VersionsSection
        data={versions.data}
        panel={panelInstalled}
        engine={data.engine}
        checking={checking}
        disabled={busy || lock.busy}
        reason={lock.reason}
        onCheck={() => void recheck()}
        onUpdate={(kind, latest) => void updateComponent(kind, latest)}
        onEngine={() => setEngineOpen(true)}
      />

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
              // секрет тот же - ссылки пользователя не меняются; окно переходит на новое имя
              await mtApi.exec(s.id, 'secret.rename', { label: openUser.label, new: name });
              setUser(name);
              await refresh();
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
