import { type TgHealth, failingFor } from '@/components/telegram-banner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, Search, Send } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface TgSettings {
  token: string;
  tokenSet: boolean;
  chatId: string;
  events: { offline: boolean; audit: boolean; bans: boolean; updates: boolean };
  banThreshold: number;
  paymentDays: number;
  lastRoute: { via: string; at: string } | null;
  health: TgHealth;
}

/** Путь доставки (lib/telegram.ts): proxy:<id> - выход xray, agent:<id> - агент сервера. */
function routeTitle(via: string, servers: { id: string; name: string }[] | undefined): string {
  const name = (id: string) => servers?.find((x) => x.id === id)?.name ?? id;
  if (via === 'direct') return 'напрямую с хоста панели';
  if (via === 'env' || via === 'proxy') return 'через прокси';
  if (via.startsWith('proxy:')) return `через выход xray ${name(via.slice(6))}`;
  return `через агент ${name(via.replace(/^agent:/, ''))}`;
}

const eventTitles: Record<keyof TgSettings['events'], string> = {
  offline: 'Сервер пропал (3 минуты без агента) и вернулся',
  audit: 'Новые и закрытые критичные замечания аудита',
  bans: 'Рост банов fail2ban (порог ниже)',
  updates: 'Обновления пакетов и сервисов (3X-UI, Xray, MTProxyL), платежи хостингу',
};

/** Настройки Telegram-уведомлений: бот, чат, какие события, тест. */
export function TelegramSettings() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: servers } = useServers();
  const { data: st } = useQuery({
    queryKey: ['tg-settings'],
    queryFn: () => api<TgSettings>('/api/notify/telegram'),
  });
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [events, setEvents] = useState<TgSettings['events'] | null>(null);
  const [banThreshold, setBanThreshold] = useState<string | null>(null);
  const [paymentDays, setPaymentDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [found, setFound] = useState<{ id: string; title: string; when: string }[] | null>(null);

  if (!st) return null;
  const ev = events ?? st.events;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/notify/telegram', {
        method: 'PUT',
        json: {
          token: token.trim() || undefined,
          chatId: (chatId ?? st?.chatId ?? '').trim(),
          events: ev,
          banThreshold: Number(banThreshold ?? st?.banThreshold ?? 10),
          paymentDays: Number(paymentDays ?? st?.paymentDays ?? 3),
        },
      });
      setToken('');
      await qc.invalidateQueries({ queryKey: ['tg-settings'] });
      setMsg({ tone: 'ok', text: 'Сохранено' });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/notify/telegram/test', { method: 'POST' });
      setMsg({ tone: 'ok', text: 'Сообщение отправлено, проверь Telegram' });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['tg-settings'] });
      void qc.invalidateQueries({ queryKey: ['tg-health'] });
    }
  }

  /** Спросить у Telegram, кто писал боту, и предложить их chat id. */
  async function detect() {
    setBusy(true);
    setMsg(null);
    setFound(null);
    try {
      const r = await api<{ chats: { id: string; title: string; when: string }[] }>(
        '/api/notify/telegram/detect',
        { method: 'POST', json: { token: token.trim() || undefined } },
      );
      if (r.chats.length === 0) {
        setMsg({
          tone: 'bad',
          text: 'Боту пока никто не писал. Открой чат с ботом в Telegram, нажми Start (или отправь любое сообщение) и повтори',
        });
      } else {
        setFound(r.chats);
        if (r.chats.length === 1) setChatId(r.chats[0]?.id ?? '');
      }
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (
      !(await ask({
        title: 'Отключить уведомления?',
        text: 'Токен бота и chat id будут удалены, уведомления перестанут приходить.',
        okLabel: 'Отключить',
        danger: true,
      }))
    )
      return;
    try {
      await api('/api/notify/telegram/clear', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['tg-settings'] });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    }
  }

  return (
    <Section
      title="Уведомления в Telegram"
      info='Создай бота у @BotFather и вставь его токен. Chat id - это номер чата, куда бот будет писать (твой личный чат с ботом, группа или канал). Открой чат с ботом, нажми Start, затем нажми "Найти chat id" - панель подставит номер сама. Панель шлёт только выбранные события, не чаще раза в час на сервер для банов и раза в сутки для обновлений.'
      extra={
        <>
          {!st.tokenSet ? (
            <Chip tone="warn">не настроено</Chip>
          ) : st.health.ok === false ? (
            <Chip tone="bad" title={st.health.lastError ?? undefined}>
              не доходят{failingFor(st.health.failingSince)}
              {st.health.pending > 0 ? `, отложено ${st.health.pending}` : ''}
            </Chip>
          ) : (
            <Chip tone="ok">бот задан</Chip>
          )}
          {st.lastRoute && (
            <span className="text-xs text-muted">
              последняя доставка {ago(st.lastRoute.at)} {routeTitle(st.lastRoute.via, servers)}
            </span>
          )}
        </>
      }
      actions={
        <>
          <Button size="sm" disabled={busy || !st.tokenSet} onClick={test} label="Тест">
            <Send className="size-3.5" />
          </Button>
          {st.tokenSet && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={clear} label="Отключить">
              <Power className="size-3.5" />
            </Button>
          )}
        </>
      }
    >
      <form onSubmit={save} className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Токен бота" htmlFor="tg-token">
            <Input
              id="tg-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                st.tokenSet ? `задан (${st.token}); вставь новый, чтобы заменить` : '123456:ABC...'
              }
            />
          </Field>
          <Field label="Chat id" htmlFor="tg-chat">
            <div className="flex gap-2">
              <Input
                id="tg-chat"
                value={chatId ?? st.chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="например 123456789 или -100..."
                className="font-mono"
              />
              <Button
                type="button"
                className="shrink-0"
                disabled={busy || (!token.trim() && !st.tokenSet)}
                onClick={detect}
                title="Спросить у Telegram, кто писал боту"
                label="Найти chat id"
              >
                <Search className="size-4" />
              </Button>
            </div>
          </Field>
        </div>
        {found && found.length > 0 && (
          <div className="flex flex-col gap-1 text-[13px]">
            <div className="text-muted">Боту писали (нажми, чтобы подставить):</div>
            <div className="flex flex-wrap gap-2">
              {found.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  size="sm"
                  variant={(chatId ?? st.chatId) === c.id ? 'primary' : 'default'}
                  onClick={() => setChatId(c.id)}
                >
                  {c.title} <span className="font-mono opacity-70">{c.id}</span>
                </Button>
              ))}
            </div>
            <div className="text-xs text-muted">После выбора нажми "Сохранить", затем "Тест".</div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {(Object.keys(eventTitles) as (keyof TgSettings['events'])[]).map((k) => (
            <Checkbox
              key={k}
              label={eventTitles[k]}
              checked={ev[k]}
              onChange={(e) => setEvents({ ...ev, [k]: e.target.checked })}
            />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Порог банов fail2ban в час" htmlFor="tg-bans">
            <Input
              id="tg-bans"
              type="number"
              min={1}
              value={banThreshold ?? String(st.banThreshold)}
              onChange={(e) => setBanThreshold(e.target.value)}
            />
          </Field>
          <Field label="Напоминать о платеже за N дней" htmlFor="tg-pay">
            <Input
              id="tg-pay"
              type="number"
              min={0}
              max={60}
              value={paymentDays ?? String(st.paymentDays)}
              onChange={(e) => setPaymentDays(e.target.value)}
            />
          </Field>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Section>
  );
}
