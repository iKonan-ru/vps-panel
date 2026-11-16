import { ActionPanel } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { useStepUp } from '@/components/ui/step-up';
import { Switch } from '@/components/ui/switch';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { bytes, dateShort } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LOG_CATEGORIES,
  LOG_CATEGORY_TITLES,
  LOG_DAYS_MAX,
  LOG_MB_MAX,
  LOG_MB_MIN,
  type LogAccessState,
  type LogCategory,
  type LogFilter,
  type LogSettings,
  type LogsView,
} from '@vps/protocol';
import { Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

type Draft = { enabled: boolean; days: Record<LogCategory, string>; maxMb: string };

const toDraft = (s: LogSettings): Draft => ({
  enabled: s.enabled,
  days: Object.fromEntries(LOG_CATEGORIES.map((c) => [c, String(s.days[c])])) as Draft['days'],
  maxMb: String(s.maxMb),
});

const intIn = (v: string, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
};

/** Дата из поля (день в поясе пользователя) - начало этого дня в ISO; конец - начало следующего. */
const dayStart = (v: string, plus = 0): string => {
  const d = new Date(`${v}T00:00:00`);
  d.setDate(d.getDate() + plus);
  return d.toISOString();
};

/**
 * Журнал серверов: что хранится и сколько, сроки по разделам, предел размера, выгрузка и
 * удаление записей по фильтру.
 */
export function LogsSettings() {
  const qc = useQueryClient();
  const { data, isFetching } = useQuery({
    queryKey: ['logs'],
    queryFn: () => api<LogsView>('/api/logs'),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [server, setServer] = useState('');
  const [cats, setCats] = useState<LogCategory[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ip, setIp] = useState('');
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl');
  const op = useAction();
  const confirm = useConfirm();
  const { stepUp, dialog } = useStepUp();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  // запущенное действие журнала доступа: до его конца и свежего состояния блок занят
  const [act, setAct] = useState<{ id: string; title: string; done: boolean } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;

  useEffect(() => {
    if (data && !draft) setDraft(toDraft(data.settings));
  }, [data, draft]);

  if (!data || !draft) return null;
  const busy = op.busy || isFetching || Boolean(act && !act.done);
  const st = data.stats;
  const valid =
    LOG_CATEGORIES.every((c) => intIn(draft.days[c], 1, LOG_DAYS_MAX)) &&
    intIn(draft.maxMb, LOG_MB_MIN, LOG_MB_MAX);
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(data.settings));

  const filter = (): LogFilter => ({
    ...(server ? { servers: [server] } : {}),
    ...(cats.length ? { categories: cats } : {}),
    ...(from ? { from: dayStart(from) } : {}),
    ...(to ? { to: dayStart(to, 1) } : {}),
    ...(ip.trim() ? { ip: ip.trim() } : {}),
  });
  const filtered = Boolean(server || cats.length || from || to || ip.trim());

  async function save(next: Draft, ok: string) {
    setMsg(null);
    await op.run(async () => {
      const body: LogSettings = {
        enabled: next.enabled,
        days: Object.fromEntries(
          LOG_CATEGORIES.map((c) => [c, Number(next.days[c])]),
        ) as LogSettings['days'],
        maxMb: Number(next.maxMb),
      };
      const v = await api<LogsView>('/api/logs/settings', { method: 'PUT', json: body });
      qc.setQueryData(['logs'], v);
      setDraft(toDraft(v.settings));
      setMsg({ tone: 'ok', text: ok });
    });
  }

  async function exportLogs() {
    if (!(await stepUp())) return;
    const f = filter();
    const q = new URLSearchParams({ format });
    if (f.servers) q.set('servers', f.servers.join(','));
    if (f.categories) q.set('categories', f.categories.join(','));
    if (f.from) q.set('from', f.from);
    if (f.to) q.set('to', f.to);
    if (f.ip) q.set('ip', f.ip);
    window.location.assign(`/api/logs/export?${q}`);
  }

  async function remove(all: boolean) {
    const ok = await confirm({
      title: all ? 'Очистить журнал?' : 'Удалить записи журнала?',
      text: all
        ? 'Будут удалены все записи журнала по всем серверам. Восстановить их нельзя.'
        : 'Будут удалены записи, подходящие под выбранные сервер, разделы, период и адрес. Восстановить их нельзя.',
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok || !(await stepUp())) return;
    setMsg(null);
    await op.run(async () => {
      const r = await api<LogsView & { deleted: number }>('/api/logs/delete', {
        method: 'POST',
        json: all ? {} : filter(),
      });
      qc.setQueryData(['logs'], { settings: r.settings, stats: r.stats, access: r.access });
      setMsg({ tone: 'ok', text: `Удалено записей: ${r.deleted}` });
    });
  }

  async function toggleAccess(a: LogAccessState) {
    const on = !a.enabled;
    const ok = await confirm({
      title: on
        ? `Включить журнал доступа Xray на ${a.name}?`
        : `Выключить журнал доступа Xray на ${a.name}?`,
      text: on
        ? 'Xray перезапустится, клиенты VLESS этого сервера переподключатся. Журнал пишется на диск сервера, агент раз в минуту забирает из него сводку по часам и не даёт ему разрастись.'
        : 'Xray перезапустится, клиенты VLESS этого сервера переподключатся. Назначения клиентов этого сервера перестанут записываться.',
      okLabel: on ? 'Включить' : 'Выключить',
    });
    if (!ok) return;
    setMsg(null);
    await op.run(async () => {
      const r = await api<{ actionId: string }>(`/api/logs/access/${a.serverId}`, {
        method: 'POST',
        json: { enabled: on },
      });
      setAct({ id: r.actionId, title: `${a.name}: журнал доступа Xray`, done: false });
    });
  }

  return (
    <>
      <Section
        title="Журнал серверов"
        info="Связь агентов с панелью, подключения адресов к сервисам и их клиенты, назначения клиентов VLESS, проверки доступности по каждому зонду, действия и их ошибки, изменения на серверах (сервисы, контейнеры, порты, баны fail2ban, входы по SSH, нехватка памяти, падения служб, перезагрузки), нагрузка. Агент копит записи и без связи с панелью. Хранится отдельно от базы панели и не входит в её резервную копию. В записях есть адреса клиентов."
        extra={
          data.settings.enabled ? (
            <Chip tone="ok">{bytes(st.bytes)}</Chip>
          ) : (
            <Chip tone="muted">выключен</Chip>
          )
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={draft.enabled}
              disabled={busy}
              label="Журнал серверов"
              onChange={() => {
                const next = { ...draft, enabled: !draft.enabled };
                void save(next, next.enabled ? 'Журнал включён' : 'Журнал выключен');
              }}
            />
            <span className="text-[13px]">Запись журнала</span>
          </div>
        </div>
        <Table>
          <THead>
            <tr>
              <th>Раздел</th>
              <th className="text-right">Записей</th>
              <th className="hidden sm:table-cell">С какого дня</th>
              <th>Хранить, дней</th>
            </tr>
          </THead>
          <TBody>
            {LOG_CATEGORIES.map((c) => (
              <tr key={c}>
                <td>{LOG_CATEGORY_TITLES[c]}</td>
                <td className="text-right tabular-nums">
                  {st.categories[c].rows.toLocaleString('ru-RU')}
                </td>
                <td className="hidden whitespace-nowrap text-muted sm:table-cell">
                  {st.categories[c].oldest ? dateShort(st.categories[c].oldest) : <>&mdash;</>}
                </td>
                <td>
                  <Input
                    aria-label={`${LOG_CATEGORY_TITLES[c]}: хранить, дней`}
                    inputMode="numeric"
                    className="h-8 w-20"
                    value={draft.days[c]}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, days: { ...draft.days, [c]: e.target.value } })
                    }
                  />
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
        <div className="flex flex-wrap items-end gap-2 p-4">
          <Field
            label="Предел размера, МБ"
            htmlFor="logs-max"
            hint="Сверх него удаляются самые старые записи"
            className="w-44"
          >
            <Input
              id="logs-max"
              inputMode="numeric"
              value={draft.maxMb}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, maxMb: e.target.value })}
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || !valid || !changed}
            onClick={() => void save(draft, 'Настройки журнала сохранены')}
          >
            Сохранить
          </Button>
        </div>

        {data.access.length > 0 && (
          <div className="border-t border-border">
            <div className="flex items-center gap-1 px-4 pt-4 text-[13px] font-medium">
              Журнал доступа Xray
            </div>
            <div className="px-4 pt-1 text-xs text-muted">
              Из него берутся назначения: куда ходят клиенты VLESS, по часам.
            </div>
            <Table className="mt-2">
              <TBody>
                {data.access.map((a) => (
                  <tr key={a.serverId}>
                    <td className="w-full">{a.name}</td>
                    <td className="whitespace-nowrap">
                      {!a.online ? (
                        <Chip tone="muted">не в сети</Chip>
                      ) : !a.agent ? (
                        <Chip tone="muted">агент устарел</Chip>
                      ) : a.error ? (
                        <Chip tone="bad">{a.error}</Chip>
                      ) : a.enabled === null ? (
                        <Chip tone="muted">нет данных</Chip>
                      ) : a.enabled ? (
                        <Chip tone="ok">включён</Chip>
                      ) : (
                        <Chip tone="muted">выключен</Chip>
                      )}
                    </td>
                    <td className="text-right">
                      {a.online && a.agent && a.enabled !== null && (
                        <Button size="sm" disabled={busy} onClick={() => void toggleAccess(a)}>
                          {a.enabled ? 'Выключить' : 'Включить'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Сервер" htmlFor="logs-server">
              <Select
                id="logs-server"
                value={server}
                disabled={busy}
                onChange={(e) => setServer(e.target.value)}
              >
                <option value="">Все серверы</option>
                {st.servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Адрес" htmlFor="logs-ip">
              <Input
                id="logs-ip"
                value={ip}
                disabled={busy}
                placeholder="любой"
                onChange={(e) => setIp(e.target.value)}
              />
            </Field>
            <Field label="С" htmlFor="logs-from">
              <Input
                id="logs-from"
                type="date"
                value={from}
                disabled={busy}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="По" htmlFor="logs-to">
              <Input
                id="logs-to"
                type="date"
                value={to}
                disabled={busy}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {LOG_CATEGORIES.map((c) => (
              <Checkbox
                key={c}
                label={LOG_CATEGORY_TITLES[c]}
                checked={cats.includes(c)}
                disabled={busy}
                onChange={() =>
                  setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])
                }
              />
            ))}
          </div>
          <div className="text-xs text-muted">
            Без выбранных разделов выгружаются и удаляются все.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Формат выгрузки"
              className="w-28"
              value={format}
              disabled={busy}
              onChange={(e) => setFormat(e.target.value as 'jsonl' | 'csv')}
            >
              <option value="jsonl">JSONL</option>
              <option value="csv">CSV</option>
            </Select>
            <Button disabled={busy} onClick={() => void exportLogs()}>
              <Download className="size-4" />
              Выгрузить
            </Button>
            <Button
              variant="danger"
              disabled={busy || !filtered}
              onClick={() => void remove(false)}
            >
              <Trash2 className="size-4" />
              Удалить выбранное
            </Button>
            <Button
              variant="ghost"
              className="text-bad hover:text-bad"
              disabled={busy}
              onClick={() => void remove(true)}
            >
              Очистить журнал
            </Button>
          </div>
          {note && <Alert tone={note.tone}>{note.text}</Alert>}
        </div>
      </Section>
      {act && (
        <ActionPanel
          title={act.title}
          actionId={act.id}
          onHide={() => setAct(null)}
          onFinished={() =>
            void (async () => {
              // состояние журнала доступа панель забирает у агента сразу после действия
              await new Promise((r) => setTimeout(r, 1500));
              await qc.invalidateQueries({ queryKey: ['logs'] });
              setAct((x) => x && { ...x, done: true });
            })()
          }
        />
      )}
      {dialog}
    </>
  );
}
