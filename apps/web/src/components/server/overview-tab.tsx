import { ActionOutput } from '@/components/action-output';
import { AccessCard } from '@/components/server/access-card';
import { BannedIps } from '@/components/server/banned-ips';
import { BaselineDialog } from '@/components/server/baseline-dialog';
import { CleanupDialog } from '@/components/server/cleanup-dialog';
import { HostingCard } from '@/components/server/hosting-card';
import { MetricCard } from '@/components/server/metric-card';
import { SshKeysDialog } from '@/components/server/ssh-keys-dialog';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { LinkButton } from '@/components/ui/link-button';
import { Num } from '@/components/ui/num';
import { Section } from '@/components/ui/section';
import { TBody, Table } from '@/components/ui/table';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { gb } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { type ServiceUpdateKind, startServiceUpdate } from '@/lib/service-update';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Finding } from '@vps/protocol';
import {
  ArrowRight,
  Box,
  ClipboardCheck,
  Download,
  KeyRound,
  Plus,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** Команда каталога, которая удаляет сервис этого вида (кнопка-корзина в блоке Сервисы). */
const uninstallCommand: Record<string, string> = {
  xui: 'xui-uninstall',
  mtproxyl: 'mtproxyl-uninstall',
  wdtt: 'wdtt-uninstall',
  amnezia: 'awg-uninstall',
  openflux: 'openflux-uninstall',
  naive: 'naive-uninstall',
};

/** Обновление установленного сервиса (проверяет панель раз в 6 часов). */
interface ServiceUpdate {
  kind: ServiceUpdateKind;
  title: string;
  current: string;
  latest: string;
}

interface SecurityRow {
  key: string;
  chip: ReactNode;
  text: string;
  hint?: string | undefined;
  action: ReactNode;
}

function SeverityChip({ severity }: { severity: Finding['severity'] }) {
  return (
    <Chip tone={severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'muted'}>
      {severity === 'high' ? 'критично' : severity === 'medium' ? 'средне' : 'к сведению'}
    </Chip>
  );
}

function mbps(bps: number): string {
  const m = (bps * 8) / 1_000_000;
  return m >= 10 ? String(Math.round(m)) : m.toFixed(1);
}

/** Вкладка "Обзор": метрики, сервисы, хостинг, обслуживание (обновления и проверки безопасности). */
export function OverviewTab({ s, onTab }: { s: ServerDetail; onTab?: (tab: string) => void }) {
  // диалог исправления: null - закрыт, '' - все шаги, иначе - шаг из замечания
  const qc = useQueryClient();
  const [baseline, setBaseline] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [keys, setKeys] = useState(false);
  // запущенное из блока "Обслуживание" действие с выводом: обновление пакетов или сервиса
  // recheck - это было обновление сервиса: по окончании перепроверить его версии
  const [upgrade, setUpgrade] = useState<{ id: string; title: string; recheck?: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const pending = s.audit?.pendingUpdates ?? 0;

  async function startUpgrade() {
    setError(null);
    try {
      const r = await actions.upgrade(s.id);
      setUpgrade({ id: r.actionId, title: 'Обновление пакетов' });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // версии в ключе: после обновления инвентарь меняется, и список перезапрашивается
  const versions = s.services.map((v) => `${v.kind}:${v.version ?? ''}`).join(',');
  const { data: svcUpdates } = useQuery({
    queryKey: ['service-updates', s.id, versions],
    queryFn: () => api<ServiceUpdate[]>(`/api/servers/${s.id}/updates`),
    refetchInterval: 10 * 60_000,
  });
  async function updateService(u: ServiceUpdate) {
    setError(null);
    try {
      const r = await startServiceUpdate[u.kind](s.id);
      setUpgrade({ id: r.actionId, title: `Обновление ${u.title} до ${u.latest}`, recheck: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const m = s.metrics;
  const findings = s.audit?.findings ?? [];
  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны
  const lock = serverLock(s);
  const canAct = online && !lock.busy;
  // есть ли замечания, которые чинит агент (url вида fix:<шаг>)
  const fixable = findings.filter((f) => f.url?.startsWith('fix:')).length;

  // Строки блока "Обслуживание": у каждой одна кнопка действия справа
  const busy = !canAct || upgrade !== null;
  const rows: SecurityRow[] = [
    ...(svcUpdates ?? []).map((u) => ({
      key: `update-${u.kind}`,
      chip: <Chip tone="update">обновление</Chip>,
      text: `${u.title}: доступна версия ${u.latest}`,
      hint: u.current ? `сейчас ${u.current}` : undefined,
      action: (
        <Button
          size="sm"
          disabled={busy}
          title={lock.reason}
          onClick={() => updateService(u)}
          label="Обновить"
        >
          <Download className="size-3.5" />
        </Button>
      ),
    })),
    ...(pending > 0
      ? [
          {
            key: 'pending-updates',
            chip: <SeverityChip severity="medium" />,
            text: `Ожидают установки обновления безопасности: ${pending}`,
            hint: 'apt upgrade без docker и ядра',
            action: (
              <Button
                size="sm"
                disabled={busy}
                title={lock.reason}
                onClick={startUpgrade}
                label="Обновить"
              >
                <Download className="size-3.5" />
              </Button>
            ),
          },
        ]
      : []),
    // строку про пакеты агент пишет без действия - её заменяет строка выше
    ...findings
      .filter((f) => !(pending > 0 && !f.url && f.text.startsWith('Ожидают установки обновлени')))
      .map((f) => ({
        key: f.text,
        chip: <SeverityChip severity={f.severity} />,
        text: f.text,
        hint: f.fix,
        action: findingAction(f),
      })),
  ];

  /** Кнопка замечания аудита по его url: fix:, cleanup:, tab:, cmd: (команда каталога) или ссылка. */
  function findingAction(f: Finding) {
    const url = f.url ?? '';
    if (url.startsWith('cmd:'))
      return (
        <ButtonLink
          to="/commands/$id"
          params={{ id: url.slice(4) }}
          search={{ server: s.id, run: undefined, tab: undefined }}
          size="sm"
          label="Исправить"
        >
          <Wrench className="size-3.5" />
        </ButtonLink>
      );
    if (url.startsWith('fix:'))
      return (
        <Button
          size="sm"
          disabled={!canAct}
          title={lock.reason}
          onClick={() => setBaseline(url.slice(4))}
          label="Исправить"
        >
          <Wrench className="size-3.5" />
        </Button>
      );
    if (url === 'cleanup:')
      return (
        <Button
          size="sm"
          disabled={!canAct}
          title={lock.reason}
          onClick={() => setCleanup(true)}
          label="Очистить"
        >
          <Trash2 className="size-3.5" />
        </Button>
      );
    if (url.startsWith('tab:'))
      return (
        <Button size="sm" onClick={() => onTab?.(url.slice(4))} label="Открыть">
          <ArrowRight className="size-3.5" />
        </Button>
      );
    if (url) return <LinkButton href={url} label="Открыть" />;
    return null;
  }

  return (
    <>
      {/* на мобиле по две в ряд даже на узком экране */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <MetricCard
          label="CPU"
          value={m ? <Num value={m.cpuPercent} format={(v) => `${Math.round(v)}%`} /> : '-'}
          note={
            m ? (
              <span title="Средняя нагрузка (load average) за 1 минуту">
                нагрузка <Num value={m.load1} format={(v) => v.toFixed(2)} />
              </span>
            ) : (
              'нет данных'
            )
          }
          pct={m ? m.cpuPercent : null}
          hidePct
        />
        <MetricCard
          label="Память"
          value={m ? <Num value={m.memUsedMb / 1024} format={gb} /> : '-'}
          unit={`/ ${m ? gb(m.memTotalMb / 1024) : '-'} ГБ`}
          note={
            m ? (
              <>
                свободно <Num value={(m.memTotalMb - m.memUsedMb) / 1024} format={gb} /> ГБ
              </>
            ) : (
              'нет данных'
            )
          }
          pct={m && m.memTotalMb > 0 ? (m.memUsedMb / m.memTotalMb) * 100 : null}
        />
        <MetricCard
          label="Диск"
          value={m ? <Num value={m.diskUsedGb} format={gb} /> : '-'}
          unit={`/ ${m ? gb(m.diskTotalGb) : '-'} ГБ`}
          note={
            m ? (
              <>
                свободно <Num value={m.diskTotalGb - m.diskUsedGb} format={gb} /> ГБ
              </>
            ) : (
              'нет данных'
            )
          }
          pct={m && m.diskTotalGb > 0 ? (m.diskUsedGb / m.diskTotalGb) * 100 : null}
          action={
            <Button
              variant="link"
              className="text-xs"
              disabled={!canAct}
              title={lock.reason ?? 'Найти и удалить мусор: кэш docker и apt, старые логи, /tmp'}
              aria-label="Очистить диск"
              onClick={() => setCleanup(true)}
            >
              <Trash2 className="size-3.5 md:size-3" />
              <span className="hidden md:inline">очистить</span>
            </Button>
          }
        />
        <MetricCard
          label={
            <>
              Сеть<span className="hidden md:inline"> - вход / выход</span>
            </>
          }
          value={m ? <Num value={m.netRxBps} format={mbps} /> : '-'}
          unit={<>/ {m ? <Num value={m.netTxBps} format={mbps} /> : '-'} Мбит/с</>}
          note={
            <>
              <span className="md:hidden">вход / выход</span>
              <span className="hidden md:inline">среднее за 30 с</span>
            </>
          }
        />
      </div>

      {/* minmax(0, ...): колонки не растут от длинного содержимого (список портов 3x-ui с узлами) */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Section
            title="Сервисы"
            actions={
              <ButtonLink
                to="/commands"
                size="sm"
                title="Каталог команд: установка и удаление сервисов"
                label="Установить сервис"
              >
                <Plus className="size-3.5" />
              </ButtonLink>
            }
          >
            {s.services.length === 0 && (
              <div className="px-4 py-3 text-[13px] text-muted">Сервисы не обнаружены.</div>
            )}
            {s.services.map((sv, i) => (
              // по верхнему краю и кнопки не сжимаются: при длинном списке портов (перенос на
              // несколько строк) кнопки стоят там же, где у коротких строк
              <div
                key={`${sv.kind}-${sv.title}-${i}`}
                className="flex items-start gap-3.5 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
                  <Box className="size-4" />
                </div>
                <div className="min-w-0 grow">
                  <div className="font-medium">
                    {/* старые агенты присылают "3x-ui" - название панели берём по виду сервиса */}
                    {sv.kind === 'xui' ? '3X-UI' : sv.title}
                    {sv.version && <span className="ml-1.5 text-xs text-muted">{sv.version}</span>}
                    {sv.details?.down === true && (
                      <Chip tone="bad" className="ml-1.5">
                        не работает
                      </Chip>
                    )}
                  </div>
                  {sv.details?.down === true && typeof sv.details.downReason === 'string' && (
                    <div className="mt-0.5 break-words text-xs text-bad">
                      {sv.details.downReason}
                    </div>
                  )}
                  <div className="mt-0.5 break-words text-xs text-muted">
                    {sv.ports.join(' - ') || 'порты не определены'}
                  </div>
                </div>
                <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                  {(s.panelLinks[sv.kind] ?? sv.panelUrl) && (
                    <LinkButton href={s.panelLinks[sv.kind] ?? sv.panelUrl ?? ''} label="Открыть" />
                  )}
                  {uninstallCommand[sv.kind] && (
                    <ButtonLink
                      to="/commands/$id"
                      params={{ id: uninstallCommand[sv.kind] ?? '' }}
                      search={{ server: s.id, run: undefined, tab: undefined }}
                      size="icon-sm"
                      variant="ghost"
                      title="Удалить с сервера (команда каталога с подтверждением)"
                      aria-label="Удалить с сервера"
                    >
                      <Trash2 className="size-3.5 text-bad" />
                    </ButtonLink>
                  )}
                </div>
              </div>
            ))}
          </Section>
          <HostingCard serverId={s.id} hosting={s.hosting} />
          <Section
            title={
              <span className="inline-flex items-center gap-2">
                <ClipboardCheck className="size-4 text-muted" />
                Обслуживание
              </span>
            }
            info="Обновления сервисов и пакетов и проверки безопасности: SSH без паролей, ufw + port-sync, fail2ban, автообновления безопасности, сертификаты, настройки панелей. Перед исправлением покажет, что именно изменится."
            extra={
              <>
                {high > 0 && <Chip tone="bad">{high} критичных</Chip>}
                {medium > 0 && <Chip tone="warn">{medium} средних</Chip>}
              </>
            }
            actions={
              <>
                <Button
                  size="sm"
                  disabled={!canAct}
                  onClick={() => setKeys(true)}
                  title={
                    lock.reason ?? 'Ключи в authorized_keys root: просмотр, удаление, добавление'
                  }
                  label="Ключи root"
                >
                  <KeyRound className="size-3.5" />
                </Button>
                {fixable > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canAct}
                    title={lock.reason}
                    onClick={() => setBaseline('')}
                    label={`Исправить проблемы (${fixable})`}
                  >
                    <Wrench className="size-3.5" />
                  </Button>
                )}
              </>
            }
          >
            {error && (
              <div className="px-4 pt-3">
                <Alert tone="bad">{error}</Alert>
              </div>
            )}
            {upgrade && (
              <div className="flex flex-col gap-2 border-b border-border p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {upgrade.title}
                  <div className="grow" />
                  <Button size="sm" variant="ghost" onClick={() => setUpgrade(null)} label="Скрыть">
                    <X className="size-3.5" />
                  </Button>
                </div>
                <ActionOutput
                  actionId={upgrade.id}
                  onFinished={() => {
                    if (!upgrade.recheck) return;
                    void api(`/api/servers/${s.id}/updates/check`, { method: 'POST' })
                      .catch(() => {})
                      .then(() => qc.invalidateQueries({ queryKey: ['service-updates'] }));
                  }}
                />
              </div>
            )}
            {!s.audit ? (
              <div className="px-4 py-3 text-[13px] text-muted">
                Аудит появится после первого подключения агента.
              </div>
            ) : (
              <Table>
                <TBody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className="w-[110px]">{r.chip}</td>
                      <td>
                        {r.text}
                        {r.hint && <div className="mt-0.5 text-xs text-muted">{r.hint}</div>}
                      </td>
                      <td className="w-px text-right">{r.action}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td className="py-3 text-ok">Замечаний нет</td>
                    </tr>
                  )}
                </TBody>
              </Table>
            )}
            {s.audit && <BannedIps audit={s.audit} />}
          </Section>
        </div>
        <AccessCard serverId={s.id} />
      </div>
      <CleanupDialog serverId={s.id} open={cleanup} onClose={() => setCleanup(false)} />
      <BaselineDialog
        serverId={s.id}
        open={baseline !== null}
        preselect={baseline || null}
        onClose={() => setBaseline(null)}
      />
      {/* окно монтируется при открытии: каждое открытие - с чистой формой, без прошлой ошибки */}
      {keys && <SshKeysDialog serverId={s.id} open={keys} onClose={() => setKeys(false)} />}
    </>
  );
}
