import { Chip } from '@/components/ui/chip';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, dateShort, daysUntil, daysWord, paymentSoon, plural } from '@/lib/format';
import { type ReachTarget, type ServerReach, reachLevel, useReachAll } from '@/lib/reach';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ServerSummary } from '@vps/protocol';
import { CircleAlert } from 'lucide-react';

/** Обновление сервиса (lib/service-updates.ts на сервере). */
interface ServiceUpdate {
  kind: 'xui' | 'xray' | 'mtproxyl' | 'mtproxyl-panel';
  title: string;
  latest: string;
}

/** Вкладка сервера, где обновляется сервис: у 3X-UI - своя, движок и панель MTProxyL - MTProxyL. */
const updateTab: Record<ServiceUpdate['kind'], string> = {
  xui: 'xui',
  xray: 'xui',
  mtproxyl: 'mtproxyl',
  'mtproxyl-panel': 'mtproxyl',
};

/** Обновления 3x-ui и MTProxyL по всем серверам: один запрос на страницу. */
function useServiceUpdates() {
  return useQuery({
    queryKey: ['service-updates-all'],
    queryFn: () => api<Record<string, ServiceUpdate[]>>('/api/updates'),
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Что на сервере требует действия: замечания аудита (firewall и docker мимо firewall - тоже
 * замечания), перезагрузка, обновления пакетов и сервисов, устаревший агент. Нечего делать -
 * пусто. Что именно - в подсказке плашки; плашка - ссылка туда, где действие: обновление
 * сервиса - его вкладка, остальное - "Обзор" (замечания и пакеты - блок "Обслуживание", агент и
 * перезагрузка - кнопки в шапке карточки, оплата - "Хостинг"). mobile - ещё то, что на мобиле негде показать
 * отдельно: сервер не в сети и скорая оплата.
 */
function attention(
  s: ServerSummary,
  updates: ServiceUpdate[],
  mobile: boolean,
  reach: ServerReach | undefined,
): {
  key: string;
  tone: 'bad' | 'warn' | 'update';
  text: string;
  title?: string;
  pulse?: boolean;
  /** вкладка карточки сервера с действием; нет - плашка не ссылка */
  tab?: string;
}[] {
  const out: ReturnType<typeof attention> = [];
  if (mobile && s.status === 'offline')
    out.push({ key: 'offline', tone: 'bad', text: `не в сети ${ago(s.lastSeenAt)}` });
  const pending = s.audit?.pendingUpdates ?? 0;
  // строку аудита про пакеты заменяет плашка "пакеты: N"
  const findings = (s.audit?.findings ?? []).filter(
    (f) => !(pending > 0 && f.text.startsWith('Ожидают установки обновлени')),
  );
  const high = findings.filter((f) => f.severity === 'high');
  const medium = findings.filter((f) => f.severity === 'medium');
  if (high.length)
    out.push({
      key: 'high',
      tab: 'overview',
      tone: 'bad',
      text: `${high.length} ${plural(high.length, 'критичное', 'критичных', 'критичных')}`,
      title: high.map((f) => f.text).join('\n'),
    });
  if (medium.length)
    out.push({
      key: 'medium',
      tab: 'overview',
      tone: 'warn',
      text: `${medium.length} ${plural(medium.length, 'замечание', 'замечания', 'замечаний')}`,
      title: medium.map((f) => f.text).join('\n'),
    });
  for (const t of reachProblems(reach))
    out.push({
      key: `reach-${t.key}`,
      tab: t.key === 'mtproxyl' ? 'mtproxyl' : 'overview',
      tone: reachLevel(t.percent) === 'bad' ? 'bad' : 'warn',
      text: `из РФ: ${reachShort(t)} ${t.percent}%`,
      title: `${t.title}: из России дошли ${t.ok} из ${t.total}\u00a0зондов${t.errors[0] ? ` (${t.errors[0]})` : ''}`,
    });
  if (s.audit?.rebootRequired)
    out.push({
      key: 'reboot',
      tab: 'overview',
      tone: 'warn',
      text: 'перезагрузка',
      title: 'Требуется перезагрузка: обновлено ядро или libc',
    });
  if (pending > 0)
    out.push({
      key: 'packages',
      tab: 'overview',
      tone: 'update',
      text: `пакеты: ${pending}`,
      title: 'Обновления безопасности ждут установки',
    });
  for (const u of updates)
    out.push({
      key: `svc-${u.kind}`,
      tone: 'update',
      text: `${u.title} ${u.latest}`,
      title: `Доступна версия ${u.title} ${u.latest}`,
      tab: updateTab[u.kind],
    });
  if (s.agentUpdating)
    out.push({
      key: 'agent',
      tone: 'update',
      text: 'агент обновляется',
      pulse: true,
      tab: 'overview',
    });
  else if (s.agentUpdateAvailable)
    out.push({
      key: 'agent',
      tone: 'warn',
      text: 'агент устарел',
      title: `Версия агента: ${s.agentVersion ?? ''}`,
      tab: 'overview',
    });
  if (mobile) {
    const days = daysUntil(s.hosting.nextPaymentAt);
    if (paymentSoon(days))
      out.push({
        key: 'pay',
        tab: 'overview',
        tone: 'warn',
        text: `оплата ${daysWord(days)}`,
        title: `Оплата до ${dateShort(s.hosting.nextPaymentAt)}`,
      });
  }
  return out;
}

/**
 * Что не видно из России: цели ниже 80%. Адрес не виден - inbound-ы того же адреса не
 * перечисляем (их не видно по той же причине), MTProxyL - отдельно (его проверка своя).
 */
function reachProblems(r: ServerReach | undefined): ReachTarget[] {
  const bad = (r?.targets ?? []).filter((t) => {
    const lv = reachLevel(t.percent);
    return lv === 'bad' || lv === 'partial';
  });
  const ip = bad.find((t) => t.key === 'ip' && reachLevel(t.percent) === 'bad');
  return ip ? bad.filter((t) => t === ip || t.source === 'mtproxyl') : bad;
}

function reachShort(t: ReachTarget): string {
  if (t.key === 'ip') return 'адрес';
  if (t.key === 'mtproxyl') return 'MTProxy';
  return t.title.replace(/^3X-UI /, '');
}

export function AttentionChips({ s, mobile = false }: { s: ServerSummary; mobile?: boolean }) {
  const { data: updates } = useServiceUpdates();
  const { data: reach } = useReachAll();
  const items = attention(s, updates?.[s.id] ?? [], mobile, reach?.[s.id]);
  if (!items.length) return null;
  const chips = items.map((i) => <AttentionItem key={i.key} i={i} serverId={s.id} />);
  if (!mobile) return <span className="flex flex-wrap gap-1">{chips}</span>;
  // в карточке на мобиле - отдельной полосой под чертой и со значком: не сливается с плашками
  // сервисов строкой выше
  const tone = items.some((i) => i.tone === 'bad')
    ? 'text-bad'
    : items.some((i) => i.tone === 'warn')
      ? 'text-warn'
      : 'text-update';
  return (
    <div className="-mx-3.5 flex items-start gap-2 border-t border-border px-3.5 pt-2.5">
      <CircleAlert
        className={cn('mt-0.5 size-4 shrink-0', tone)}
        role="img"
        aria-label="Требует внимания"
      />
      <span className="flex min-w-0 flex-wrap gap-1">{chips}</span>
    </div>
  );
}

/** Плашка "Требует внимания": ссылка на вкладку с действием, если оно есть. */
function AttentionItem({
  i,
  serverId,
}: { i: ReturnType<typeof attention>[number]; serverId: string }) {
  const chip = (
    <Chip
      tone={i.tone}
      title={i.title}
      dot={i.pulse === true}
      pulse={i.pulse === true}
      className={i.tab ? 'hover:brightness-125' : undefined}
    >
      {i.text}
    </Chip>
  );
  if (!i.tab) return <span className="inline-flex">{chip}</span>;
  return (
    <Link
      to="/servers/$id/$tab"
      params={{ id: serverId, tab: i.tab }}
      className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-accent"
    >
      {chip}
    </Link>
  );
}
