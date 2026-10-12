import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Power, RefreshCw, Route } from 'lucide-react';
import { useState } from 'react';

type XrayCheck = { at: string; ok: boolean; ms: number; err: string | null };

/** Выход xray (lib/xray.ts XrayExitView). */
interface XrayExit {
  serverId: string;
  serverName: string;
  inboundId: number;
  inboundRemark: string;
  address: string;
  port: number;
  uuid: string;
  sni: string;
  updatedAt: string;
  primary: boolean;
  lastCheck: XrayCheck | null;
}

interface XrayStatus {
  configured: boolean;
  binary: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  lastCheck: XrayCheck | null;
  outbound: XrayExit | null;
  exits: XrayExit[];
  spares: { at: string | null; errors: { server: string; error: string }[] };
}

interface Inbound {
  id: number;
  remark: string;
  port: number;
  enable: boolean;
  tcp: boolean;
}

/**
 * Выход панели в Telegram через xray (VLESS-Reality к 3x-ui на заграничных серверах):
 * основной выход - выбор сервера и инбаунда, запасные панель готовит сама; статус каждого
 * выхода, проверка, отключение.
 */
export function XraySettings() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: st } = useQuery({
    queryKey: ['xray'],
    queryFn: () => api<XrayStatus>('/api/xray'),
    refetchInterval: 30_000,
  });
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState('');
  const [inboundId, setInboundId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

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
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['xray'] });
      if (label) setMsg({ tone: 'ok', text: label });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const setup = () =>
    run('', async () => {
      const r = await api<{ check: NonNullable<XrayStatus['lastCheck']> }>('/api/xray/setup', {
        method: 'POST',
        json: { serverId, inboundId },
      });
      setMsg(
        r.check.ok
          ? { tone: 'ok', text: `Настроено, Telegram отвечает через прокси за ${r.check.ms} мс` }
          : { tone: 'bad', text: `Настроено, но проверка не прошла: ${r.check.err ?? ''}` },
      );
    });

  const check = () =>
    run('', async () => {
      const r = await api<{ status: XrayStatus }>('/api/xray/check', { method: 'POST' });
      const all = r.status.exits;
      const ok = all.filter((x) => x.lastCheck?.ok).length;
      setMsg(
        ok > 0
          ? { tone: 'ok', text: `Telegram отвечает через ${ok} из ${all.length} выходов` }
          : { tone: 'bad', text: `Ни один выход не отвечает: ${all[0]?.lastCheck?.err ?? ''}` },
      );
    });

  const prepareSpares = () =>
    run('Запасные выходы подготовлены', () => api('/api/xray/spares', { method: 'POST' }));

  const disable = async () => {
    const ok = await ask({
      title: 'Отключить выход через xray?',
      text: 'Основной и запасные выходы выключатся, уведомления пойдут напрямую или через агентов. Клиенты vps-panel в 3X-UI останутся.',
      okLabel: 'Отключить',
      danger: true,
    });
    if (ok) void run('Выключено', () => api('/api/xray/disable', { method: 'POST' }));
  };

  const tone = !st.configured
    ? 'muted'
    : st.running && st.lastCheck?.ok !== false
      ? 'ok'
      : st.running
        ? 'warn'
        : 'bad';
  const label = !st.configured
    ? 'не настроено'
    : !st.running
      ? 'не запущен'
      : st.lastCheck?.ok === false
        ? 'запущен, проверка не прошла'
        : 'работает';

  return (
    <Section
      title="Маршрут до Telegram"
      info={
        <>
          С хоста панели Telegram недоступен, поэтому панель держит xray-клиент к твоему же 3X-UI на
          заграничных серверах (VLESS-Reality) и ходит к Telegram через него. Основной выход
          выбираешь ты, запасные панель готовит сама на остальных серверах с 3X-UI (раз в 6 часов):
          клиент <span className="font-mono">vps-panel</span> на первом Reality-inbound-е по TCP.
          Каждый выход проверяется раз в 5 минут; не отвечает основной - сообщение уйдёт через
          следующий, затем напрямую и через агентов.
        </>
      }
      extra={
        <Chip tone={tone} dot={st.running}>
          {label}
        </Chip>
      }
      actions={
        st.configured ? (
          <>
            <Button size="sm" disabled={busy} onClick={check} label="Проверить">
              <Activity className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={disable} label="Отключить">
              <Power className="size-3.5" />
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {st.configured && (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-muted">
              Процесс:{' '}
              {st.running
                ? `pid ${st.pid}, запущен ${st.startedAt ? ago(st.startedAt) : ''}`
                : 'не запущен'}
              {st.restarts > 0 ? `, перезапусков ${st.restarts}` : ''}
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
                      {x.inboundRemark || `#${x.inboundId}`}, порт {x.port}, SNI {x.sni}, клиент{' '}
                      <span className="font-mono">vps-panel {x.uuid}</span>
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
                    <Chip className="mt-px">не проверялся</Chip>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="grow">
                Запасные: {st.exits.length > 1 ? st.exits.length - 1 : 'нет'}
                {st.spares.at ? `, подготовлены ${ago(st.spares.at)}` : ''}
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={prepareSpares}
                label="Подготовить запасные"
                short="Подготовить"
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
          <Alert tone="bad">
            В образе панели нет бинарника xray: пересобери контейнер (deploy/Dockerfile).
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-medium">
            {st.configured ? 'Сменить основной выход' : 'Настроить выход'}
          </div>
          {candidates.length === 0 ? (
            <div className="text-[13px] text-muted">
              Нет серверов на связи, где агент нашёл 3X-UI.
            </div>
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
                  <option value="">выбери сервер</option>
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
                      ? 'сначала сервер'
                      : inbounds.isLoading
                        ? 'загружаю...'
                        : inbounds.data?.inbounds.length === 0
                          ? 'Reality-inbound-ов нет'
                          : 'выбери inbound'}
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
                disabled={busy || !serverId || inboundId === '' || !st.binary}
                onClick={setup}
                label={busy ? 'Настраиваю...' : 'Настроить'}
                short={busy ? 'Настраиваю...' : 'Настроить'}
              >
                <Route className="size-4" />
              </Button>
            </div>
          )}
          {inbounds.error && (
            <div className="text-[13px] text-bad">{(inbounds.error as Error).message}</div>
          )}
        </div>

        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Section>
  );
}
