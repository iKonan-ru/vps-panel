import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import {
  type ReachTarget,
  type ServerReach,
  reachLevel,
  reachTone,
  useServerReach,
} from '@/lib/reach';
import { useQueryClient } from '@tanstack/react-query';
import { Radar } from 'lucide-react';
import { useState } from 'react';

const barColor = { ok: 'bg-ok', partial: 'bg-warn', bad: 'bg-bad' } as const;

/** История: столбик на проверку (высота - процент дошедших зондов), последние 24. */
function History({ t }: { t: ReachTarget }) {
  const pts = t.history.slice(-24);
  if (pts.length < 2) return null;
  return (
    <span className="flex h-5 items-end gap-px" aria-hidden="true">
      {pts.map((p) => {
        const lv = reachLevel(p.percent) ?? 'bad';
        return (
          <span
            key={p.at}
            title={`${ago(p.at)}: ${p.percent}% из ${p.total} зондов`}
            className={cn('w-1 rounded-sm', barColor[lv])}
            style={{ height: `${Math.max(12, p.percent)}%` }}
          />
        );
      })}
    </span>
  );
}

function Row({ t }: { t: ReachTarget }) {
  const lv = reachLevel(t.percent);
  const what =
    t.source === 'mtproxyl'
      ? 'проверяет сам MTProxyL, раз в 15 минут'
      : t.kind === 'tls'
        ? `TLS на порт ${t.port}${t.sni ? `, SNI ${t.sni}` : ''}`
        : `TCP до порта ${t.port}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0">
      <span className="min-w-0 grow">
        <span className="font-medium">{t.title}</span>
        <span className="block truncate text-xs text-muted" title={t.errors.join('\n')}>
          {what}
          {t.checkedAt ? `, ${ago(t.checkedAt)}` : ''}
          {lv && lv !== 'ok' && t.errors[0] ? ` - ${t.errors[0]}` : ''}
        </span>
        {t.error && <span className="block text-xs text-warn">{t.error}</span>}
      </span>
      <History t={t} />
      {lv ? (
        <Chip tone={reachTone[lv]} title={`дошли ${t.ok} из ${t.total} зондов`}>
          {lv === 'ok' ? 'виден' : lv === 'partial' ? 'частично' : 'не виден'} {t.percent}%
        </Chip>
      ) : (
        <Chip>нет данных</Chip>
      )}
    </div>
  );
}

/**
 * Блок "Доступность из России" во вкладке "Обзор": адрес, inbound-ы 3X-UI, MTProxyL - видны ли
 * они из домашних сетей РФ (зонды Globalping), с историей и проверкой сейчас.
 */
export function ReachCard({ serverId, online }: { serverId: string; online: boolean }) {
  const qc = useQueryClient();
  const { data } = useServerReach(serverId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<ServerReach>(`/api/servers/${serverId}/reach/check`, { method: 'POST' });
      qc.setQueryData(['reach', serverId], r);
      void qc.invalidateQueries({ queryKey: ['reach'], exact: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Доступность из России"
      info="Видят ли сервер люди в России: 10 зондов Globalping в российских домашних сетях раз в 30 минут пробуют дойти до адреса (TCP до порта SSH) и до каждого inbound-а 3X-UI (TLS-рукопожатие с его SNI или TCP до порта). Заказывает проверки агент со своего адреса: квота Globalping - 250 зондов в час на адрес. MTProxyL проверяет себя сам. От 80% - виден, от 50% - частично, ниже - не виден; о сбое двух проверок подряд и о возврате приходит уведомление."
      extra={
        data?.remaining !== undefined && (
          <span className="text-xs text-muted">квота Globalping: осталось {data.remaining}</span>
        )
      }
      actions={
        <Button
          size="sm"
          disabled={busy || !online}
          onClick={() => void check()}
          label={busy ? 'Проверяю...' : 'Проверить сейчас'}
        >
          <Radar className={cn('size-3.5', busy && 'animate-pulse')} />
        </Button>
      }
    >
      {err && (
        <div className="px-4 pt-3">
          <Alert tone="bad">{err}</Alert>
        </div>
      )}
      {data?.error && <div className="px-4 pt-3 text-xs text-warn">{data.error}</div>}
      {!data || data.targets.length === 0 ? (
        <div className="px-4 py-3 text-[13px] text-muted">
          Проверок ещё не было: первая - в течение получаса после подключения агента.
        </div>
      ) : (
        data.targets.map((t) => <Row key={t.key} t={t} />)
      )}
    </Section>
  );
}
