import { Logo } from '@/components/logo';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { Me } from '@/lib/auth';
import { codeMask } from '@/lib/masks';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

export function LoginPage() {
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { login, password } });
      setStep('totp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/totp', { method: 'POST', json: { code } });
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    // Кладём свежий ответ в кэш до перехода, иначе Gate увидит старое "не авторизован" и вернёт на вход.
    const me = await api<Me>('/api/auth/me');
    qc.setQueryData(['me'], me);
    // ?next=/api/proxy/open/... - пришли с поддомена панели сервиса: вернуться туда
    const next = new URLSearchParams(location.search).get('next') ?? '';
    if (next.startsWith('/api/proxy/open/')) {
      location.href = next;
      return;
    }
    await navigate({ to: '/' });
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="flex w-full max-w-[400px] flex-col gap-4.5 p-8">
        <Logo size={32} />
        {/* разные key: иначе React переиспользует форму и кнопку - "Назад" (пятый элемент) прямо
            во время клика становится "Дальше" (type=submit), браузер отправляет форму пароля, и
            экран кода открывается снова */}
        {step === 'password' ? (
          <form key="password" onSubmit={submitPassword} className="flex flex-col gap-4">
            <div>
              <div className="text-xl font-semibold">Вход</div>
              <div className="mt-1 text-[13px] text-muted">
                Логин и пароль администратора, затем код из приложения.
              </div>
            </div>
            <Field label="Логин" htmlFor="login">
              <Input
                id="login"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value.replace(/\s/g, ''))}
                maxLength={32}
                required
                autoFocus
              />
            </Field>
            <Field label="Пароль" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={200}
                required
              />
            </Field>
            {error && <Alert tone="bad">{error}</Alert>}
            <Button
              type="submit"
              variant="primary"
              className="h-10.5 justify-center"
              disabled={busy}
            >
              Дальше
            </Button>
          </form>
        ) : (
          <form key="totp" onSubmit={submitCode} className="flex flex-col gap-4">
            <div>
              <div className="text-xl font-semibold">Код подтверждения</div>
              <div className="mt-1 text-[13px] text-muted">
                Введи 6 цифр из приложения-аутентификатора или резервный код.
              </div>
            </div>
            <Field label="Код" htmlFor="code">
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000 000"
                className="h-12 text-center font-mono text-xl tracking-[.2em]"
                value={code}
                onChange={(e) => setCode(codeMask(e.target.value))}
                required
                autoFocus
              />
            </Field>
            {error && <Alert tone="bad">{error}</Alert>}
            <Button
              type="submit"
              variant="primary"
              className="h-10.5 justify-center"
              disabled={busy}
            >
              Войти
            </Button>
            <Button
              variant="link"
              className="self-end text-[13px] text-muted hover:text-text"
              onClick={() => setStep('password')}
            >
              Назад
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
