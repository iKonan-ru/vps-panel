import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { XrayStatus } from '@vps/protocol';
import { Activity, Power, RefreshCw, Route } from 'lucide-react';
import { useState } from 'react';

interface Inbound {
  id: number;
  remark: string;
  port: number;
  enable: boolean;
  tcp: boolean;
}

/** Состояние маршрута до Telegram (xray-клиент панели). */
export function useXrayStatus() {
  return useQuery({
    queryKey: ['xray'],
    queryFn: () => api<XrayStatus>('/api/xray'),
    refetchInterval: 30_000,
  });
}

/** Плашка состояния маршрута: тон и подпись. */
export function xrayState(st: XrayStatus): {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  label: string;
} {
  if (!st.configured) return { tone: 'muted', label: 'не настроен' };
  if (!st.running) return { tone: 'bad', label: 'не запущен' };
  if (st.lastCheck?.ok === false) return { tone: 'warn', label: 'проверка не прошла' };
  return { tone: 'ok', label: 'работает' };
}

/** Окно "Маршрут до Telegram": основной выход через xray (сервер и inbound), запасные - сами. */
export function XrayRouteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: st, isFetching } = useXrayStatus();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState('');
  const [inboundId, setInboundId] = useState<number | ''>('');
  const op = useAction();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;

  const candidates = (servers ?? []).filter(
    (s) => s.status === 'online' && s.services.some((sv) => sv.kind === 'xui'),
  );
  const inbounds = useQuery({
    queryKey: ['xray-inbounds', serverId],
    queryFn: () => api<{ inbounds: Inbound[] }>(`/api/xray/inbounds?server=${serverId}`),
    enabled: Boolean(serverId),
    retry: false,
  });

  if (!st) return null;

  async function run(label: string, fn: () => Promise<unknown>) {
    setMsg(null);
    await op.run(async () => {
      await fn();
      await qc.invalidateQueries({ queryKey: ['xray'] });
      if (label) setMsg({ tone: 'ok', text: label });
    });
  }

  const setup = () =>
    run('', async () => {
      const r = await api<{ check: NonNullable<XrayStatus['lastCheck']> }>('/api/xray/setup', {
        method: 'POST',
        json: { serverId, inboundId },
      });
      setMsg(
        r.check.ok
          ? { tone: 'ok', text: `Настроено, Telegram отвечает за ${r.check.ms}\u00a0мс` }
          : { tone: 'bad', text: `Настроено, проверка не прошла: ${r.check.err ?? ''}` },
      );
    });

  const check = () =>
    run('', async () => {
      const r = await api<{ status: XrayStatus }>('/api/xray/check', { method: 'POST' });
      const all = r.status.exits;
      const ok = all.filter((x) => x.lastCheck?.ok).length;
      setMsg(
        ok > 0
          ? { tone: 'ok', text: `Отвечают выходы: ${ok} из ${all.length}` }
          : { tone: 'bad', text: `Ни один выход не отвечает: ${all[0]?.lastCheck?.err ?? ''}` },
      );
    });

  const prepareSpares = () =>
    run('Запасные выходы готовы', () => api('/api/xray/spares', { method: 'POST' }));

  const disable = async () => {
    const ok = await ask({
      title: 'Отключить маршрут через xray?',
      text: 'Уведомления пойдут напрямую или через агенты. Клиенты vps-panel в 3X-UI останутся.',
      okLabel: 'Отключить',
      danger: true,
    });
    if (ok) void run('Выключено', () => api('/api/xray/disable', { method: 'POST' }));
  };

  const { tone, label } = xrayState(st);
  // пока идёт действие или перечитывается состояние - кнопки окна недоступны
  const locked = op.busy || isFetching;

  return (
    <Dialog open={open} onClose={onClose} title="Маршрут до Telegram" wide>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={tone} dot={st.running}>
          {label}
        </Chip>
        <InfoTip>
          Панель отправляет сообщения через 3X-UI на зарубежных серверах. Если основной выход не
          отвечает, используются запасные: клиент <span className="font-mono">vps-panel</span> на
          остальных серверах с 3X-UI.
        </InfoTip>
        <div className="grow" />
        {st.configured && (
          <>
            <Button size="sm" disabled={locked} onClick={check} label="Проверить">
              <Activity className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" disabled={locked} onClick={disable} label="Отключить">
              <Power className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-4">
        {st.configured && (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-muted">
              Xray: {st.running ? `запущен ${st.startedAt ? ago(st.startedAt) : ''}` : 'не запущен'}
              {st.restarts > 0 ? `, перезапусков: ${st.restarts}` : ''}
            </div>
            <div className="flex flex-col rounded-lg border border-border">
              {st.exits.map((x) => (
                <div
                  key={x.serverId}
                  className="flex items-start gap-3 border-b border-border px-3 py-2 text-[13px] last:border-b-0"
                >
                  <span className="min-w-0 grow">
                    <span className="font-medium">{x.serverName}</span>
                    {x.primary && (
                      <Chip tone="accent" className="ml-2">
                        основной
                      </Chip>
                    )}
                    <span className="block truncate text-xs text-muted">
                      {x.inboundRemark || `#${x.inboundId}`}, порт {x.port}, SNI {x.sni}
                    </span>
                  </span>
                  {x.lastCheck ? (
                    <Chip
                      tone={x.lastCheck.ok ? 'ok' : 'bad'}
                      className="mt-px"
                      title={`${ago(x.lastCheck.at)}${x.lastCheck.err ? `: ${x.lastCheck.err}` : ''}`}
                    >
                      {x.lastCheck.ok ? `${x.lastCheck.ms} мс` : 'не отвечает'}
                    </Chip>
                  ) : (
                    <Chip className="mt-px">не проверен</Chip>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="grow">
                Запасные: {st.exits.length > 1 ? st.exits.length - 1 : 'нет'}
                {st.spares.at ? `, обновлены ${ago(st.spares.at)}` : ''}
              </span>
              <Button
                size="sm"
                disabled={locked}
                onClick={prepareSpares}
                label="Обновить запасные"
                short="Обновить"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            {st.spares.errors.map((e) => (
              <div key={e.server} className="text-xs text-warn">
                {e.server}: {e.error}
              </div>
            ))}
            {st.lastError && <div className="font-mono text-xs text-warn">{st.lastError}</div>}
          </div>
        )}

        {!st.binary && (
          <Alert tone="bad">В образе панели нет xray: нужна пересборка контейнера</Alert>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-medium">
            {st.configured ? 'Основной выход' : 'Выход'}
          </div>
          {candidates.length === 0 ? (
            <div className="text-[13px] text-muted">Нет серверов с 3X-UI в сети</div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Сервер" htmlFor="xray-server" className="min-w-[220px]">
                <Select
                  id="xray-server"
                  value={serverId}
                  onChange={(e) => {
                    setServerId(e.target.value);
                    setInboundId('');
                  }}
                >
                  <option value="">не выбран</option>
                  {candidates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.hosting.country || s.host})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Inbound VLESS-Reality" htmlFor="xray-inbound" className="min-w-[260px]">
                <Select
                  id="xray-inbound"
                  value={inboundId}
                  disabled={!serverId || inbounds.isLoading}
                  onChange={(e) => setInboundId(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">
                    {!serverId
                      ? 'выберите сервер'
                      : inbounds.isLoading
                        ? 'загрузка\u2026'
                        : inbounds.data?.inbounds.length === 0
                          ? 'нет inbound с Reality'
                          : 'не выбран'}
                  </option>
                  {inbounds.data?.inbounds.map((i) => (
                    <option key={i.id} value={i.id} disabled={!i.enable || !i.tcp}>
                      {i.remark || `#${i.id}`} : {i.port}
                      {!i.enable ? ' (выключен)' : !i.tcp ? ' (не TCP)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="primary"
                disabled={locked || !serverId || inboundId === '' || !st.binary}
                onClick={setup}
                label="Настроить"
                short="Настроить"
              >
                <Route className="size-4" />
              </Button>
            </div>
          )}
          {inbounds.error && (
            <div className="text-[13px] text-bad">{(inbounds.error as Error).message}</div>
          )}
        </div>

        {note && <Alert tone={note.tone}>{note.text}</Alert>}
      </div>
    </Dialog>
  );
}
