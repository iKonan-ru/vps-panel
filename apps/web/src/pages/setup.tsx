import { Logo } from '@/components/logo';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QrCode } from '@/components/ui/qr-code';
import { api } from '@/lib/api';
import type { Me } from '@/lib/auth';
import { codeMask } from '@/lib/masks';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

interface SetupResult {
  totpUri: string;
  totpSecret: string;
  backupCodes: string[];
}

/** Мастер первого запуска: администратор, 2FA, резервные коды. */
export function SetupPage() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [result, setResult] = useState<SetupResult | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function createAdmin(e: FormEvent) {
    e.preventDefault();
    if (password !== password2) return setError('Пароли не совпадают');
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<SetupResult>('/api/setup', { method: 'POST', json: { login, password } }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/confirm', { method: 'POST', json: { code } });
      // Сессия уже открыта: кладём ответ в кэш до перехода, чтобы не вернуться на вход.
      qc.setQueryData(['setup-status'], { setupDone: true });
      qc.setQueryData(['me'], await api<Me>('/api/auth/me'));
      await navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="flex w-full max-w-[520px] flex-col gap-4.5 p-8">
        <Logo size={32} />
        {!result ? (
          <form onSubmit={createAdmin} className="flex flex-col gap-4">
            <div>
              <div className="text-xl font-semibold">Первый запуск</div>
              <div className="mt-1 text-[13px] text-muted">
                Создай администратора. Пароль от 10 символов, дальше настроим 2FA.
              </div>
            </div>
            <Field label="Логин" htmlFor="login">
              <Input
                id="login"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value.replace(/\s/g, ''))}
                maxLength={32}
                minLength={3}
                required
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Пароль" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={200}
                  minLength={10}
                  required
                />
              </Field>
              <Field label="Ещё раз" htmlFor="password2">
                <Input
                  id="password2"
                  type="password"
                  autoComplete="new-password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  maxLength={200}
                  minLength={10}
                  required
                />
              </Field>
            </div>
            {error && <Alert tone="bad">{error}</Alert>}
            <Button
              type="submit"
              variant="primary"
              className="h-10.5 justify-center"
              disabled={busy}
            >
              Создать
            </Button>
          </form>
        ) : (
          <form onSubmit={confirm} className="flex flex-col gap-4">
            <div>
              <div className="text-xl font-semibold">Двухфакторная защита</div>
              <div className="mt-1 text-[13px] text-muted">
                Отсканируй QR в приложении-аутентификаторе (Google Authenticator, Aegis, 1Password)
                и введи код.
              </div>
            </div>
            <div className="flex flex-col items-center gap-5">
              <QrCode text={result.totpUri} alt="QR для аутентификатора" />
              <div className="flex min-w-0 flex-col gap-2 text-[13px]">
                <Label>Секрет вручную</Label>
                <code className="break-all font-mono text-xs">{result.totpSecret}</code>
                <Label className="mt-2">Резервные коды (показываются один раз)</Label>
                <div className="grid grid-cols-2 gap-x-4 font-mono text-xs">
                  {result.backupCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              </div>
            </div>
            <Checkbox
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              label="Резервные коды сохранил в надёжном месте"
            />
            <Field label="Код из приложения" htmlFor="code">
              <Input
                id="code"
                inputMode="numeric"
                placeholder="000 000"
                className="h-12 text-center font-mono text-xl tracking-[.2em]"
                value={code}
                onChange={(e) => setCode(codeMask(e.target.value))}
                required
              />
            </Field>
            {error && <Alert tone="bad">{error}</Alert>}
            <Button
              type="submit"
              variant="primary"
              className="h-10.5 justify-center"
              disabled={busy || !saved}
            >
              Включить 2FA и войти
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
