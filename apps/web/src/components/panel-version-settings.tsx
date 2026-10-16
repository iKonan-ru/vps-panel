import { type DeployInfo, markPanelUpdate, useDeploy } from '@/components/deploy-banner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { LinkButton } from '@/components/ui/link-button';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { ago, utcHourLocal } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PanelUpdateView } from '@vps/protocol';
import { ArrowUpCircle, ExternalLink, RefreshCw } from 'lucide-react';

/** Репозиторий панели: исходники, релизы, документация. */
const REPO_URL = 'https://github.com/iKonan-ru/vps-panel';

const KEY = ['panel-update'];

/**
 * Версия панели и новые релизы канала (без запросов к GitHub: панель отдаёт свою проверку) -
 * блок "Версия панели" и плашка у логотипа в меню (panel-version-badge.tsx), общий кэш.
 */
export function usePanelUpdate(refetchMs = 10 * 60_000) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<PanelUpdateView>('/api/panel/update'),
    refetchInterval: refetchMs,
  });
}
/** Час автообновления хранится в UTC; в списке - местное время браузера, по порядку суток. */
const HOURS = [...Array(24).keys()]
  .map((h) => ({ h, label: utcHourLocal(h) }))
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * Версия панели: новые релизы в своём канале со списком изменений, обновление по кнопке (его
 * ставит служба на хосте, vps-panel), канал, автообновление и обновление агентов за панелью.
 */
export function PanelVersionSettings() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: deploy } = useDeploy();
  const updating = deploy?.status?.state === 'building';
  const { data: cached } = usePanelUpdate();
  // пока обновление запрошено или идёт - чаще: блок узнаёт о конце сам
  const { data: st, isFetching } = usePanelUpdate(cached?.requested || updating ? 5000 : 60_000);
  const op = useAction();
  if (!st) return null;

  // занято: свой запрос, перечитывание версий, запрошенное или идущее обновление панели -
  // кнопки и переключатели блока недоступны
  const busy = op.busy || isFetching || Boolean(st.requested) || updating;
  const run = (fn: () => Promise<PanelUpdateView>) =>
    op.run(async () => {
      qc.setQueryData(KEY, await fn());
    });
  const save = (patch: Partial<PanelUpdateView>) =>
    run(() => api('/api/panel/update/settings', { method: 'PUT', json: patch }));
  const top = st.newer[0];

  async function update(v: string) {
    if (
      !(await ask({
        title: `Обновить панель до ${v}?`,
        text: 'Панель будет недоступна около минуты, VPN на серверах продолжит работать. При сбое вернётся прежняя версия.',
        okLabel: 'Обновить',
      }))
    )
      return;
    await run(async () => {
      const view = await api<PanelUpdateView>('/api/panel/update', {
        method: 'POST',
        json: { version: v },
      });
      // полоса хода - сразу, не дожидаясь первого шага службы на хосте и опроса плашки (раз
      // в 30 с): со статусом "идёт" она опрашивается раз в 3 с и сменится настоящим ходом
      const status = markPanelUpdate(v, st?.current ?? null);
      qc.setQueryData<DeployInfo>(['deploy'], (d) => (d ? { ...d, status } : d));
      return view;
    });
  }

  return (
    <Section
      title="Версия панели"
      info="Предварительный канал получает и предварительные версии. Из консоли: vps-panel update"
      extra={
        <>
          <Chip>{st.current}</Chip>
          {top ? (
            <Chip tone="update">доступна {top.version}</Chip>
          ) : (
            st.checkedAt && !st.error && <Chip tone="ok">актуальная</Chip>
          )}
          {st.checkedAt && (
            <span className="text-xs text-muted">проверено {ago(st.checkedAt)}</span>
          )}
        </>
      }
      actions={
        <>
          <LinkButton href={REPO_URL} label="GitHub" />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run(() => api('/api/panel/update/check', { method: 'POST' }))}
            label="Проверить"
          >
            <RefreshCw
              className={op.busy && !st.requested ? 'size-3.5 animate-spin' : 'size-3.5'}
            />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {!st.managed && (
          <Alert>Панель собрана из исходников: обновление из интерфейса недоступно</Alert>
        )}
        {st.error && <Alert tone="bad">Проверка версий: {st.error}</Alert>}
        {top && (
          <div className="flex flex-col gap-2 rounded-lg border border-border">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
              <div className="min-w-0 grow text-[13px]">
                {st.newer.length === 1 ? 'Новая версия' : `Новых версий: ${st.newer.length}`}
              </div>
              {updating ? (
                <Chip tone="accent">обновляется до {deploy?.status?.commit}</Chip>
              ) : st.requested ? (
                <Chip tone="accent">запрошено обновление до {st.requested}</Chip>
              ) : (
                st.managed && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => update(top.version)}
                  >
                    <ArrowUpCircle className="size-3.5" />
                    Обновить до {top.version}
                  </Button>
                )
              )}
            </div>
            <div className="flex max-h-80 flex-col gap-3 overflow-y-auto px-3 pb-3">
              {st.newer.map((r) => (
                <div key={r.version} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                    {r.version}
                    {r.prerelease && <Chip>предварительная</Chip>}
                    <span className="text-xs font-normal text-muted">{ago(r.publishedAt)}</span>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-normal text-accent"
                    >
                      GitHub <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <div className="whitespace-pre-wrap text-xs text-muted">{r.notes.trim()}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {op.error && <Alert tone="bad">{op.error}</Alert>}
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center gap-3">
            <label htmlFor="panel-channel" className="grow">
              Канал обновлений
            </label>
            <Select
              id="panel-channel"
              size="sm"
              className="w-40 shrink-0"
              value={st.channel}
              disabled={busy}
              onChange={(e) => save({ channel: e.target.value as 'stable' | 'beta' })}
            >
              <option value="stable">стабильный</option>
              <option value="beta">предварительный</option>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <div className="grow">Автоматическое обновление панели</div>
            {st.autoUpdate && (
              <Select
                size="sm"
                className="w-24 shrink-0"
                aria-label="Время обновления"
                value={st.autoHour}
                disabled={busy}
                onChange={(e) => save({ autoHour: Number(e.target.value) })}
              >
                {HOURS.map(({ h, label }) => (
                  <option key={h} value={h}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
            <Switch
              label="Автоматическое обновление панели"
              checked={st.autoUpdate}
              disabled={busy || !st.managed}
              onChange={() => save({ autoUpdate: !st.autoUpdate })}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="grow">Автоматическое обновление агентов</div>
            <Switch
              label="Автоматическое обновление агентов"
              checked={st.agentsAuto}
              disabled={busy}
              onChange={() => save({ agentsAuto: !st.agentsAuto })}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}
