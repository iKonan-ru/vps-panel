import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { api } from '@/lib/api';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Подтверждение для особо чувствительных действий: пароль и код 2FA. Бэкенд ставит
 * короткую cookie, поэтому повторять для каждого запроса в течение 5 минут не нужно.
 */
export function useStepUp() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const confirmedAt = useRef(0);

  const finish = useCallback((ok: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    setPassword('');
    setCode('');
    setError('');
    setBusy(false);
    if (ok) confirmedAt.current = Date.now();
    resolve?.(ok);
  }, []);

  const stepUp = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (Date.now() - confirmedAt.current < 4 * 60_000) return resolve(true);
        pending.current = resolve;
        setError('');
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (open) {
      setPassword('');
      setCode('');
      setError('');
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/step-up', {
        method: 'POST',
        json: { password, ...(code.trim() ? { code: code.trim() } : {}) },
      });
      finish(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось подтвердить');
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={open} onClose={() => finish(false)} title="Подтверждение действия">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="text-sm text-muted">
          Бэкап панели и управление ботом требуют повторного подтверждения. Оно действует 5 минут.
        </div>
        <Field label="Пароль" htmlFor="step-up-password">
          <PasswordInput
            id="step-up-password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Код 2FA"
          htmlFor="step-up-code"
          hint={
            'код из приложения или резервный код; если 2FA не настроена\u00a0\u2014 оставьте пустым'
          }
        >
          <Input
            id="step-up-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => finish(false)} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            Подтвердить
          </Button>
        </div>
      </form>
    </Dialog>
  );

  return { stepUp, dialog };
}
