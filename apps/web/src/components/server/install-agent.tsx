import { ActionOutput } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useCopy } from '@/lib/use-copy';
import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, RotateCcw } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';

type Mode = 'password' | 'key' | 'manual';

/**
 * Установка (и переустановка) агента: по SSH паролем root, ключом панели
 * или вручную командой. Вывод установщика показывается живьём.
 */
export function InstallAgent({
  serverId,
  host,
  onDone,
}: { serverId: string; host: string; onDone?: (ok: boolean) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // установка закончилась: до этого "Повторить" не даёт запустить второй установщик поверх
  const [finished, setFinished] = useState(false);
  const [keyReset, setKeyReset] = useState(false);
  const key = useQuery({
    queryKey: ['panel-ssh-key'],
    queryFn: () => api<{ publicKey: string }>('/api/panel/ssh-key'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  async function start(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'manual') {
        const r = await actions.registration(serverId);
        setCommand(r.installCommand);
      } else {
        const r = await api<{ actionId: string }>(`/api/servers/${serverId}/install`, {
          method: 'POST',
          json: mode === 'password' ? { mode, password } : { mode },
        });
        setPassword('');
        setActionId(r.actionId);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Сервер переустановлен - ключ SSH-хоста другой, а панель помнит старый отпечаток. */
  async function resetHostKey() {
    try {
      await api(`/api/servers/${serverId}/host-key`, { method: 'DELETE' });
      setKeyReset(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (actionId) {
    return (
      <div className="flex flex-col gap-3">
        <ActionOutput
          actionId={actionId}
          onFinished={(code) => {
            setFinished(true);
            setFailed(code !== 0);
            onDone?.(code === 0);
          }}
        />
        {error && <Alert tone="bad">{error}</Alert>}
        {keyReset && (
          <Alert tone="ok">Отпечаток сброшен: при следующей установке запомнится новый ключ</Alert>
        )}
        <div className="flex justify-end gap-2">
          {failed && !keyReset && (
            <Button
              size="sm"
              onClick={resetHostKey}
              label="Сбросить отпечаток SSH"
              short="Сбросить отпечаток"
              title="Если сервер переустановлен и его ключ SSH сменился"
            >
              <KeyRound className="size-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            disabled={!finished}
            onClick={() => {
              setActionId(null);
              setFinished(false);
              setFailed(false);
              setKeyReset(false);
              setError(null);
            }}
            label="Повторить"
            short="Повторить"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          active={mode === 'password'}
          onClick={() => setMode('password')}
          title="Пароль root"
          text="Используется один раз, панель его не хранит."
        />
        <ModeCard
          active={mode === 'key'}
          onClick={() => setMode('key')}
          title="Ключ панели"
          text="Если публичный ключ панели уже добавлен на сервер."
        />
        <ModeCard
          active={mode === 'manual'}
          onClick={() => setMode('manual')}
          title="Вручную"
          text="Панель даст команду, выполнишь сам."
        />
      </div>

      {mode === 'password' && (
        <Field label={<>Пароль root для {host}</>} htmlFor="inst-pass">
          <Input
            id="inst-pass"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
      )}
      {mode === 'key' && (
        <div className="flex flex-col gap-2 text-[13px]">
          <div className="text-muted">
            Публичный ключ панели. Добавь его на сервер одной командой под root, затем нажми
            "Установить":
          </div>
          <pre className="overflow-x-auto console rounded-lg p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {key.data
              ? `mkdir -p /root/.ssh && echo '${key.data.publicKey}' >> /root/.ssh/authorized_keys`
              : 'Загрузка...'}
          </pre>
          <CopyButton
            text={
              key.data
                ? `mkdir -p /root/.ssh && echo '${key.data.publicKey}' >> /root/.ssh/authorized_keys`
                : ''
            }
          />
        </div>
      )}
      {mode === 'manual' && command && (
        <div className="flex flex-col gap-2 text-[13px]">
          <div className="text-muted">
            Выполни под root на сервере. Токен в команде одноразовый и действует 1 час.
          </div>
          <pre className="overflow-x-auto console rounded-lg p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {command}
          </pre>
          <CopyButton text={command} />
        </div>
      )}
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="flex items-center gap-3">
        <InfoTip>
          Установщик ставит агента как systemd-службу. Docker, VPN и firewall не трогаются.
        </InfoTip>
        <div className="grow" />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || (mode === 'password' && !password)}
        >
          {mode === 'manual'
            ? command
              ? 'Выдать новую команду'
              : 'Показать команду'
            : 'Установить'}
        </Button>
      </div>
    </form>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  text,
}: { active: boolean; onClick: () => void; title: string; text: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
        active ? 'border-accent bg-accent/10' : 'border-border bg-surface-2 hover:border-muted',
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted">{text}</span>
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <div>
      <Button
        size="sm"
        disabled={!text}
        onClick={() => copy(text)}
        label={copied ? 'Скопировано' : 'Скопировать'}
        short={copied ? 'Скопировано' : 'Скопировать'}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}
