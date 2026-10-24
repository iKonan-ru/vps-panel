import { Alert } from '@/components/ui/alert';
import { Button, ButtonAnchor } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { QrCode } from '@/components/ui/qr-code';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotLevel, BotLink, BotView } from '@vps/protocol';
import { Link2, Send, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';

const KEY = ['tg-bot'];

const LEVELS: { id: BotLevel; title: string }[] = [
  { id: 'view', title: 'Только просмотр' },
  { id: 'safe', title: 'Безопасные действия' },
  { id: 'all', title: 'Все действия' },
];

function useBot(fast: boolean) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<BotView>('/api/notify/bot'),
    // пока открыта ссылка привязки - чаще: окно закроется само, когда аккаунт привяжется
    refetchInterval: fast ? 3_000 : 60_000,
  });
}

/** Состояние бота одной плашкой. */
function botState(b: BotView): { tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string } {
  if (!b.on) return { tone: 'muted', label: 'выключено' };
  if (b.poll.ok === false) return { tone: 'bad', label: 'нет связи с Telegram' };
  if (!b.admin) return { tone: 'warn', label: 'аккаунт не привязан' };
  return { tone: 'ok', label: 'работает' };
}

/**
 * Строка "Управление через бота" в настройках Telegram: включение, привязка аккаунта
 * администратора ссылкой с одноразовым кодом, отвязка.
 */
export function BotSettingsRow({ tokenSet }: { tokenSet: boolean }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const [link, setLink] = useState<BotLink | null>(null);
  const { data: bot, isFetching } = useBot(link !== null);
  const op = useAction();

  // аккаунт привязался - окно ссылки больше не нужно
  useEffect(() => {
    if (link && bot?.admin && Date.parse(bot.admin.at) > Date.parse(link.expiresAt) - 10 * 60_000)
      setLink(null);
  }, [bot, link]);

  if (!bot) return null;
  const state = botState(bot);
  const busy = op.busy;

  async function toggle() {
    await op.run(async () => {
      await api('/api/notify/bot', { method: 'PATCH', json: { on: !bot?.on } });
      await qc.invalidateQueries({ queryKey: KEY });
    });
  }

  async function setLevel(level: BotLevel) {
    await op.run(async () => {
      await api('/api/notify/bot', { method: 'PATCH', json: { level } });
      await qc.invalidateQueries({ queryKey: KEY });
    });
  }

  async function bind() {
    await op.run(async () => {
      setLink(await api<BotLink>('/api/notify/bot/link', { method: 'POST' }));
      await qc.invalidateQueries({ queryKey: KEY });
    });
  }

  async function unbind() {
    if (
      !(await ask({
        title: 'Отвязать аккаунт Telegram?',
        text: 'Бот перестанет отвечать этому аккаунту. Уведомления продолжат приходить.',
        okLabel: 'Отвязать',
        danger: true,
      }))
    )
      return;
    await op.run(async () => {
      await api('/api/notify/bot/unbind', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: KEY });
    });
  }

  const who = bot.admin
    ? `${bot.admin.name}${bot.admin.username ? ` (@${bot.admin.username})` : ''}`
    : null;
  return (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            Управление через бота
            <Chip tone={state.tone} title={bot.poll.error ?? undefined}>
              {state.label}
            </Chip>
          </div>
          <div className="text-xs text-muted">
            {who ?? 'сводка, серверы и журнал в чате с ботом'}
          </div>
        </div>
        {bot.admin ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={unbind} label="Отвязать">
            <Unlink className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !tokenSet} onClick={bind} label="Привязать аккаунт">
            <Link2 className="size-3.5" />
          </Button>
        )}
        <Switch
          label="Управление через бота"
          checked={bot.on}
          disabled={busy || isFetching || !tokenSet}
          onChange={toggle}
        />
      </div>
      {bot.admin && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0 grow text-xs text-muted">
            действия через бота; удаление сервера действия через бота; опасные&nbsp;&mdash; с кодом
            2FAnbsp; действия через бота; опасные&nbsp;&mdash; с кодом 2FAmdash; с кодом 2FA
          </div>
          <Select
            size="sm"
            className="w-52 shrink-0"
            aria-label="Действия через бота"
            value={bot.level}
            disabled={busy || isFetching}
            onChange={(e) => setLevel(e.target.value as BotLevel)}
          >
            {LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </Select>
        </div>
      )}
      {bot.on && bot.poll.ok === false && bot.poll.error && (
        <Alert tone="bad">{bot.poll.error}</Alert>
      )}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <Dialog open={link !== null} onClose={() => setLink(null)} title="Привязка аккаунта">
        {link && (
          <div className="flex flex-col gap-3">
            <QrCode
              text={link.url}
              alt="Ссылка на бота"
              note="Откройте камерой телефона и запустите бота"
            />
            <div className="flex justify-center">
              <ButtonAnchor href={link.url} target="_blank" rel="noreferrer" variant="primary">
                <Send className="size-4" />
                Открыть в Telegram
              </ButtonAnchor>
            </div>
            <div className="text-center text-xs text-muted">
              Ссылка одноразовая и действует 10&nbsp;минут
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
