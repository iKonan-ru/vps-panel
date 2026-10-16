import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, hm, plural } from '@/lib/format';
import {
  type ReachSlot,
  SLOT_MS,
  ms,
  reachLevel,
  reachSlots,
  reachTone,
  useReachProbes,
  useServerReach,
} from '@/lib/reach';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import type { ReachProbe, ReachTarget, ServerReach } from '@vps/protocol';
import { Radar } from 'lucide-react';
import { useEffect, useState } from 'react';

const barColor = { ok: 'bg-ok', partial: 'bg-warn', bad: 'bg-bad' } as const;

/** Текущее время раз в минуту: интервалы графика сдвигаются и без новых данных. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function slotTitle(s: ReachSlot): string {
  const range = `${hm(s.end - SLOT_MS)}-${hm(s.end)}`;
  if (s.percent === null) return `${range}: проверок не было`;
  const n = s.points.length;
  return `${range}: ${s.percent}%${n > 1 ? ` (худшая из ${n} проверок)` : ''}${
    s.rtt !== null ? `, задержка ${ms(s.rtt)}` : ''
  }`;
}

function rttTitle(s: ReachSlot): string {
  const range = `${hm(s.end - SLOT_MS)}-${hm(s.end)}`;
  return `${range}: ${s.rtt !== null ? ms(s.rtt) : 'не мерили'}`;
}

/**
 * Задержка по интервалам: столбик - медиана за полчаса, высота - от самого долгого интервала
 * на графике. Нужна, чтобы видеть, когда путь из России стал длиннее.
 */
function RttBars({ slots, picked }: { slots: ReachSlot[]; picked: number | null }) {
  const top = Math.max(...slots.map((s) => s.rtt ?? 0));
  if (top <= 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted">
        <span>Задержка, медиана за полчаса</span>
        <span>до {ms(top)}</span>
      </div>
      <div className="flex h-10 items-end gap-0.5">
        {slots.map((s) => (
          <span
            key={s.end}
            title={rttTitle(s)}
            className={cn(
              'flex h-full min-w-0 flex-1 items-end rounded-sm p-px',
              picked === s.end && 'bg-surface-2',
              s.current && 'opacity-70',
            )}
          >
            <span
              className={cn(
                'block w-full rounded-sm',
                s.rtt !== null ? 'bg-accent/60' : 'bg-border',
              )}
              style={{ height: s.rtt !== null ? `${Math.max(8, (s.rtt / top) * 100)}%` : '8%' }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

function Bar({ s, className }: { s: ReachSlot; className?: string }) {
  const lv = s.percent === null ? null : (reachLevel(s.percent) ?? 'bad');
  return (
    <span
      className={cn('block rounded-sm', lv ? barColor[lv] : 'bg-border', className)}
      style={{ height: s.percent === null ? '12%' : `${Math.max(12, s.percent)}%` }}
    />
  );
}

/**
 * История: столбик на получасовой интервал (высота - худшая проверка за него), 12 часов. Шкала
 * общая для всех целей: пустой столбик - в этот интервал проверки не было. Нажатие - подробности.
 */
function History({ t, now, onOpen }: { t: ReachTarget; now: number; onOpen: () => void }) {
  if (t.history.length === 0) return null;
  const slots = reachSlots(t.history, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1.5 flex h-5 cursor-pointer items-end gap-px rounded-sm hover:opacity-80"
      aria-label={`${t.title}: подробности`}
    >
      {slots.map((s) => (
        <span key={s.end} title={slotTitle(s)} className="flex h-full w-1 items-end">
          <Bar s={s} className="w-full" />
        </span>
      ))}
    </button>
  );
}

function what(t: ReachTarget): string {
  if (t.source === 'mtproxyl') return 'проверка MTProxyL раз в 15\u00a0мин';
  return t.kind === 'tls'
    ? `TLS на порт ${t.port}${t.sni ? `, SNI ${t.sni}` : ''}`
    : `TCP до порта ${t.port}`;
}

function Row({ t, now, onOpen }: { t: ReachTarget; now: number; onOpen: () => void }) {
  const lv = reachLevel(t.percent);
  // плашка всегда справа у названия: строка не переносится, длинное описание обрезается, история
  // - под описанием (на узком экране плашка иначе уезжала вниз то у одной строки, то у другой)
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0">
      <span className="min-w-0 grow">
        <span className="block truncate font-medium">{t.title}</span>
        <span className="block truncate text-xs text-muted" title={t.errors.join('\n')}>
          {what(t)}
          {t.checkedAt ? `, ${ago(t.checkedAt)}` : ''}
          {lv && lv !== 'ok' && t.errors[0] ? `, ${t.errors[0]}` : ''}
        </span>
        {t.error && <span className="block text-xs text-warn">{t.error}</span>}
        <History t={t} now={now} onOpen={onOpen} />
      </span>
      {t.rtt !== undefined && (
        <span
          className="mt-0.5 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted"
          title="Задержка из России: медиана по дошедшим зондам последней проверки"
        >
          {ms(t.rtt)}
        </span>
      )}
      {lv ? (
        <Chip
          tone={reachTone[lv]}
          className="mt-px"
          title={`дошли ${t.ok} из ${t.total}\u00a0зондов`}
        >
          {lv === 'ok' ? 'виден' : lv === 'partial' ? 'частично' : 'не виден'} {t.percent}%
        </Chip>
      ) : (
        <Chip className="mt-px">нет данных</Chip>
      )}
    </div>
  );
}

function ProbeItem({ p }: { p: ReachProbe }) {
  return (
    <li className="min-w-0 py-1">
      <span className="font-medium">{p.city || 'город неизвестен'}</span>{' '}
      <span className="text-muted">
        {p.network}
        {p.asn ? ` (AS${p.asn})` : ''}
      </span>
      {p.error && (
        <span className="block truncate text-xs text-muted" title={p.error}>
          {p.error}
        </span>
      )}
    </li>
  );
}

/** Одна проверка интервала: процент и зонды - откуда дошли, откуда нет. */
function Check({
  p,
  probes,
  loading,
}: {
  p: ReachSlot['points'][number];
  probes: ReachProbe[] | undefined;
  loading: boolean;
}) {
  const bad = probes?.filter((x) => !x.ok) ?? [];
  // дошедшие - от быстрых к медленным: сразу видно, откуда путь длинный
  const good = (probes?.filter((x) => x.ok) ?? []).sort(
    (a, b) => (a.rtt ?? Number.POSITIVE_INFINITY) - (b.rtt ?? Number.POSITIVE_INFINITY),
  );
  const lv = reachLevel(p.percent) ?? 'bad';
  return (
    <div className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">Проверка в {hm(p.at)}</span>
        <Chip tone={reachTone[lv]}>
          {p.percent}% из {p.total}
        </Chip>
        {p.rtt !== undefined && (
          <span className="text-xs tabular-nums text-muted">задержка {ms(p.rtt)}</span>
        )}
      </div>
      {probes ? (
        <div className="mt-2 grid gap-y-2 text-[13px]">
          <div className="min-w-0">
            <div className="text-xs font-medium text-bad">Не дошли: {bad.length}</div>
            {bad.length > 0 ? (
              <ul>
                {bad.map((x, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: зонды одной проверки не переставляются
                  <ProbeItem key={i} p={x} />
                ))}
              </ul>
            ) : (
              <div className="py-1 text-xs text-muted">все зонды дошли</div>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium text-ok">Дошли: {good.length}</div>
            {good.length > 0 ? (
              // дошедших обычно большинство: коротко плашками, сеть и AS - в подсказке
              <div className="mt-1 flex flex-wrap gap-1">
                {good.map((x, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: зонды одной проверки не переставляются
                    key={i}
                    title={`${x.network}${x.asn ? ` (AS${x.asn})` : ''}`}
                    className="max-w-full truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-xs sm:max-w-[16rem]"
                  >
                    {x.city || '?'}
                    <span className="text-muted">, {x.network}</span>
                    {x.rtt !== undefined && (
                      <span className="tabular-nums text-muted">, {ms(x.rtt)}</span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <div className="py-1 text-xs text-muted">ни один зонд не дошёл</div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-1 text-xs text-muted">
          {loading ? 'Загрузка\u2026' : 'Данных о зондах нет: они хранятся 13\u00a0ч'}
        </div>
      )}
    </div>
  );
}

/** Окно подробностей цели: крупный график (интервал выбирается нажатием) и зонды его проверок. */
function Details({
  serverId,
  t,
  now,
  onClose,
}: {
  serverId: string;
  t: ReachTarget;
  now: number;
  onClose: () => void;
}) {
  const slots = reachSlots(t.history, now, true);
  const lastWith = [...slots].reverse().find((s) => s.points.length > 0)?.end ?? null;
  const [picked, setPicked] = useState<number | null>(null);
  const sel = slots.find((s) => s.end === (picked ?? lastWith)) ?? null;
  const probes = useReachProbes(serverId, t.key);
  const byAt = new Map((probes.data ?? []).map((x) => [x.at, x.probes]));
  const first = slots[0];
  return (
    <Dialog open onClose={onClose} title={`${t.title}: доступность из России`}>
      <div className="space-y-4">
        <div className="text-xs text-muted">
          {what(t).charAt(0).toUpperCase() + what(t).slice(1)}. Столбик&nbsp;&mdash; полчаса,
          высота&nbsp;&mdash; худшая проверка за это время.
        </div>
        <div>
          <div className="flex h-20 items-end gap-0.5">
            {slots.map((s) => (
              <button
                key={s.end}
                type="button"
                title={slotTitle(s)}
                disabled={s.points.length === 0}
                onClick={() => setPicked(s.end)}
                className={cn(
                  'flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-sm p-px disabled:cursor-default',
                  sel?.end === s.end && 'bg-surface-2 outline outline-1 outline-accent',
                  s.current && 'opacity-70',
                )}
              >
                <Bar s={s} className="w-full" />
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>{first ? hm(first.end - SLOT_MS) : ''}</span>
            <span>сейчас</span>
          </div>
        </div>
        <RttBars slots={slots} picked={sel?.end ?? null} />
        {sel ? (
          <div className="space-y-3">
            <div className="text-xs font-medium text-muted">
              {hm(sel.end - SLOT_MS)}-{hm(sel.end)}
              {sel.current ? ' (идёт сейчас)' : ''}: {sel.points.length}{' '}
              {plural(sel.points.length, 'проверка', 'проверки', 'проверок')}
            </div>
            {sel.points.map((p) => (
              <Check key={p.at} p={p} probes={byAt.get(p.at)} loading={probes.isLoading} />
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-muted">Проверок за 12&nbsp;ч не было</div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Блок "Доступность из России" во вкладке "Обзор": адрес, inbound-ы 3X-UI, MTProxyL - видны ли
 * они из домашних сетей РФ (зонды Globalping), с историей и проверкой сейчас.
 */
export function ReachCard({ serverId, online }: { serverId: string; online: boolean }) {
  const qc = useQueryClient();
  const { data } = useServerReach(serverId);
  const op = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow();
  const opened = data?.targets.find((t) => t.key === open);

  async function check() {
    await op.run(async () => {
      const r = await api<ServerReach>(`/api/servers/${serverId}/reach/check`, { method: 'POST' });
      qc.setQueryData(['reach', serverId], r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['reach'], exact: true }),
        qc.invalidateQueries({ queryKey: ['reach-probes', serverId] }),
      ]);
    });
  }

  return (
    <Section
      title="Доступность из России"
      info={
        'Каждые полчаса 10 зондов Globalping из домашних сетей России проверяют адрес и inbound 3X-UI. Виден\u00a0\u2014 от 80%, частично\u00a0\u2014 от 50%. Задержка\u00a0\u2014 время установки TCP-соединения, медиана по дошедшим зондам.'
      }
      extra={
        data?.remaining !== undefined && (
          <span className="text-xs text-muted">квота Globalping: осталось {data.remaining}</span>
        )
      }
      actions={
        <Button
          size="sm"
          disabled={op.busy || !online}
          onClick={() => void check()}
          label="Проверить сейчас"
          short="Проверить"
        >
          <Radar className={cn('size-3.5', op.busy && 'animate-pulse')} />
        </Button>
      }
    >
      {op.error && (
        <div className="px-4 pt-3">
          <Alert tone="bad">{op.error}</Alert>
        </div>
      )}
      {data?.error && <div className="px-4 pt-3 text-xs text-warn">{data.error}</div>}
      {!data || data.targets.length === 0 ? (
        <div className="px-4 py-3 text-[13px] text-muted">
          Проверок пока не было: первая пройдёт в течение получаса
        </div>
      ) : (
        data.targets.map((t) => <Row key={t.key} t={t} now={now} onOpen={() => setOpen(t.key)} />)
      )}
      {opened && <Details serverId={serverId} t={opened} now={now} onClose={() => setOpen(null)} />}
    </Section>
  );
}
