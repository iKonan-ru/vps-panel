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
import { ago } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';

/** Репозиторий панели: исходники, релизы, документация. */
const REPO_URL = 'https://github.com/iKonan-ru/vps-panel';

interface PanelRelease {
  version: string;
  prerelease: boolean;
  notes: string;
  url: string;
  publishedAt: string;
}
interface PanelUpdateView {
  current: string;
  managed: boolean;
  newer: PanelRelease[];
  checkedAt: string | null;
  error: string | null;
  requested: string | null;
  channel: 'stable' | 'beta';
  autoUpdate: boolean;
  autoHour: number;
  agentsAuto: boolean;
}

const KEY = ['panel-update'];
const HOURS = [...Array(24).keys()];

/**
 * Версия панели: новые релизы в своём канале со списком изменений, обновление по кнопке (его
 * ставит служба на хосте, vps-panel), канал, автообновление и обновление агентов за панелью.
 */
export function PanelVersionSettings() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: deploy } = useDeploy();
  const updating = deploy?.status?.state === 'building';
  const { data: st, isFetching } = useQuery({
    queryKey: KEY,
    queryFn: () => api<PanelUpdateView>('/api/panel/update'),
    // пока обновление запрошено или идёт - чаще: блок узнаёт о конце сам
    refetchInterval: (q) => (q.state.data?.requested || updating ? 5000 : 60_000),
  });
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!st) return null;

  // занято: свой запрос, перечитывание версий, запрошенное или идущее обновление панели -
  // кнопки и переключатели блока недоступны
  const busy = working || isFetching || Boolean(st.requested) || updating;
  const run = async (fn: () => Promise<PanelUpdateView>) => {
    if (working) return;
    setWorking(true);
    setErr(null);
    try {
      qc.setQueryData(KEY, await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const save = (patch: Partial<PanelUpdateView>) =>
    run(() => api('/api/panel/update/settings', { method: 'PUT', json: patch }));
  const top = st.newer[0];

  async function update(v: string) {
    if (
      !(await ask({
        title: `Обновить панель до ${v}?`,
        text: 'Панель перезапустится и около минуты будет недоступна (VPN на серверах это не затрагивает). Если новая версия не поднимется, служба вернёт прежнюю.',
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
      info='Новые версии - релизы на GitHub (iKonan-ru/vps-panel). Канал "бета" получает и пре-релизы. Обновление ставит служба на сервере панели (команда vps-panel): скачивает образы, перезапускает и проверяет панель, при неудаче возвращает прежнюю версию. Из консоли - vps-panel update.'
      extra={
        <>
          <Chip>{st.current}</Chip>
          {top ? (
            <Chip tone="update">есть {top.version}</Chip>
          ) : (
            st.checkedAt && !st.error && <Chip tone="ok">свежая</Chip>
          )}
          {st.checkedAt && (
            <span className="text-xs text-muted">проверено {ago(st.checkedAt)}</span>
          )}
        </>
      }
      actions={
        <>
          <LinkButton
            href={REPO_URL}
            label="GitHub"
            title="Панель на GitHub: исходники, релизы, документация, вопросы"
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run(() => api('/api/panel/update/check', { method: 'POST' }))}
            label="Проверить"
          >
            <RefreshCw
              className={working && !st.requested ? 'size-3.5 animate-spin' : 'size-3.5'}
            />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {!st.managed && (
          <Alert>
            Панель поставлена не из релиза (сборка из исходников): обновлять её отсюда нельзя. Новые
            версии видны ниже; установка из релиза - командой из README.
          </Alert>
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
                <Chip tone="accent">обновление до {st.requested} запрошено</Chip>
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
                    {r.prerelease && <Chip>бета</Chip>}
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
        {err && <Alert tone="bad">{err}</Alert>}
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center gap-3">
            <label htmlFor="panel-channel" className="grow">
              Канал
              <span className="block text-xs text-muted">
                бета - пре-релизы раньше всех, для проверки новых версий
              </span>
            </label>
            <Select
              id="panel-channel"
              size="sm"
              className="w-36 shrink-0"
              value={st.channel}
              disabled={busy}
              onChange={(e) => save({ channel: e.target.value as 'stable' | 'beta' })}
            >
              <option value="stable">стабильный</option>
              <option value="beta">бета</option>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <div className="grow">
              Обновлять панель самой
              <span className="block text-xs text-muted">
                новая версия канала ставится в заданный час (UTC)
              </span>
            </div>
            {st.autoUpdate && (
              <Select
                size="sm"
                className="w-24 shrink-0"
                aria-label="Час обновления (UTC)"
                value={st.autoHour}
                disabled={busy}
                onChange={(e) => save({ autoHour: Number(e.target.value) })}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            )}
            <Switch
              label="Обновлять панель самой"
              checked={st.autoUpdate}
              disabled={busy || !st.managed}
              onChange={() => save({ autoUpdate: !st.autoUpdate })}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="grow">
              Обновлять агентов за панелью
              <span className="block text-xs text-muted">
                после обновления панели - по одному серверу, ошибка останавливает раскатку
              </span>
            </div>
            <Switch
              label="Обновлять агентов за панелью"
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
