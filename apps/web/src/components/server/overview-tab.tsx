import { AccessCard } from '@/components/server/access-card';
import { CleanupDialog } from '@/components/server/cleanup-dialog';
import { ClientHostCard } from '@/components/server/client-host-card';
import { HostingCard } from '@/components/server/hosting-card';
import { Maintenance } from '@/components/server/maintenance';
import { MetricCard } from '@/components/server/metric-card';
import { ReachCard } from '@/components/server/reach-card';
import { Button, ButtonLink } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { LinkButton } from '@/components/ui/link-button';
import { Num } from '@/components/ui/num';
import { Section } from '@/components/ui/section';
import { gb, plural } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { serviceByKind } from '@vps/protocol';
import { Box, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

function mbps(bps: number): string {
  const m = (bps * 8) / 1_000_000;
  return m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace('.', ',');
}

/** Вкладка "Обзор": метрики, сервисы, хостинг, обслуживание (обновления и проверки безопасности). */
export function OverviewTab({ s, onTab }: { s: ServerDetail; onTab?: (tab: string) => void }) {
  const m = s.metrics;
  const cores = s.inventory?.host.cpuCores;
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны
  const lock = serverLock(s);
  const canAct = online && !lock.busy;
  const [cleanup, setCleanup] = useState(false);

  return (
    <>
      {/* на мобиле по две в ряд даже на узком экране */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <MetricCard
          label="CPU"
          value={m ? <Num value={m.cpuPercent} format={(v) => `${Math.round(v)}%`} /> : '-'}
          unit={cores ? `/ ${cores}\u00a0${plural(cores, 'ядро', 'ядра', 'ядер')}` : undefined}
          note={
            m ? (
              <span title={'Load average за 1\u00a0мин'}>
                нагрузка <Num value={m.load1} format={(v) => v.toFixed(2).replace('.', ',')} />
                {cores ? ` из ${cores}` : ''}
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
                свободно <Num value={(m.memTotalMb - m.memUsedMb) / 1024} format={gb} />
                &nbsp;ГБ
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
                свободно <Num value={m.diskTotalGb - m.diskUsedGb} format={gb} />
                &nbsp;ГБ
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
              title={lock.reason ?? 'Кэш docker и apt, старые логи, /tmp'}
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
              Сеть<span className="hidden md:inline">: вход / выход</span>
            </>
          }
          value={m ? <Num value={m.netRxBps} format={mbps} /> : '-'}
          unit={<>/ {m ? <Num value={m.netTxBps} format={mbps} /> : '-'} Мбит/с</>}
          note={
            <>
              <span className="md:hidden">вход / выход</span>
              <span className="hidden md:inline">среднее за 30&nbsp;с</span>
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
                search={{ server: s.id }}
                size="sm"
                label="Установить сервис"
              >
                <Plus className="size-3.5" />
              </ButtonLink>
            }
          >
            {s.services.length === 0 && (
              <div className="px-4 py-3 text-[13px] text-muted">Сервисов нет</div>
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
                    {sv.title}
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
                    {sv.ports.join(', ') || 'порты не определены'}
                  </div>
                </div>
                <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                  {(s.panelLinks[sv.kind] ?? sv.panelUrl) && (
                    <LinkButton href={s.panelLinks[sv.kind] ?? sv.panelUrl ?? ''} label="Открыть" />
                  )}
                  {serviceByKind(sv.kind)?.uninstall && (
                    <ButtonLink
                      to="/commands/$id"
                      params={{ id: serviceByKind(sv.kind)?.uninstall ?? '' }}
                      search={{
                        server: s.id,
                        run: undefined,
                        tab: undefined,
                        // AWG: удаляется именно этот контейнер, а не выбранный в форме по умолчанию
                        ...(sv.kind === 'amnezia' && typeof sv.details?.container === 'string'
                          ? { preset: { AWG_CONTAINER: sv.details.container } }
                          : {}),
                      }}
                      size="icon-sm"
                      variant="ghost"
                      title="Удалить с сервера"
                      aria-label="Удалить с сервера"
                    >
                      <Trash2 className="size-3.5 text-bad" />
                    </ButtonLink>
                  )}
                </div>
              </div>
            ))}
          </Section>
          <ReachCard serverId={s.id} online={online} />
          <Maintenance s={s} onTab={onTab} onCleanup={() => setCleanup(true)} />
        </div>
        <div className="flex flex-col gap-4">
          <ClientHostCard serverId={s.id} />
          <HostingCard serverId={s.id} hosting={s.hosting} />
          <AccessCard serverId={s.id} />
        </div>
      </div>
      <CleanupDialog serverId={s.id} open={cleanup} onClose={() => setCleanup(false)} />
    </>
  );
}
