import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { Shuffle } from 'lucide-react';
import { useCallback, useEffect, useId, useRef } from 'react';

/** Выбор известного заранее порта: внешний firewall настраивается до запуска операции. */
export function SshPortFields({
  serverId,
  port,
  ready,
  disabled,
  onPort,
  onReady,
  onBusy,
}: {
  serverId: string;
  port: string;
  ready: boolean;
  disabled: boolean;
  onPort: (value: string) => void;
  onReady: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}) {
  const id = useId();
  const pick = useAction();
  const initialized = useRef(false);
  const busy = disabled || pick.busy;
  const change = (value: string) => {
    onPort(value);
    onReady(false);
  };
  const pickPort = useCallback(
    () =>
      pick.run(async () => {
        onReady(false);
        onBusy?.(true);
        try {
          const result = await api<{ port: number }>(`/api/servers/${serverId}/ssh-port/pick`, {
            method: 'POST',
          });
          onPort(String(result.port));
        } finally {
          onBusy?.(false);
        }
      }),
    [serverId, onPort, onReady, onBusy, pick.run],
  );

  useEffect(() => {
    if (initialized.current || disabled) return;
    // Только первое пустое поле: ручной ввод, включая очистку, сохраняется при рендерах.
    initialized.current = true;
    if (!port) void pickPort();
  }, [disabled, port, pickPort]);

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Новый порт SSH"
        htmlFor={id}
        hint="1024-65535. Порт 22 допустим для возврата стандартного порта."
      >
        <div className="flex gap-1.5">
          <Input
            id={id}
            inputMode="numeric"
            value={port}
            disabled={busy}
            onChange={(e) => change(e.target.value)}
            className="min-w-0 grow font-mono"
          />
          <Button
            size="icon"
            title="Случайный свободный порт"
            aria-label="Случайный свободный порт"
            disabled={busy}
            onClick={() => void pickPort()}
          >
            <Shuffle className="size-4" />
          </Button>
        </div>
      </Field>
      <p className="text-xs text-muted">
        Смена порта снижает шум сканирования и не заменяет вход по ключу и fail2ban. Панель проверит
        вход своим ключом до закрытия прежних портов. Правила ufw переносятся; в других локальных
        фильтрах новый порт нужно разрешить вручную.
      </p>
      <Checkbox
        checked={ready}
        disabled={busy || !validSshPort(port)}
        onChange={(e) => onReady(e.target.checked)}
        label={`TCP ${port || 'нового порта'} разрешён во внешнем firewall хостинга (или его нет)`}
        hint="Панель не управляет firewall хостинга. Сначала разрешить новый порт с адреса панели и своих адресов. Прежний порт закрывать только после успешной смены."
      />
      {pick.error && <Alert tone="bad">{pick.error}</Alert>}
    </div>
  );
}

export function validSshPort(value: string) {
  return (
    /^\d+$/.test(value) &&
    (Number(value) === 22 || (Number(value) >= 1024 && Number(value) <= 65535))
  );
}
