import { Logo } from '@/components/logo';
import { TotpEnroll, type TotpSetup } from '@/components/totp-enroll';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { Me } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { codeMask } from '@/lib/masks';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

/** Администратора ещё нет: его создаёт установка или консоль сервера панели. */
export function NoAdminPage() {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="flex w-full max-w-[440px] flex-col gap-4 p-8">
        <Logo size={32} />
        <div className="text-xl font-semibold">Администратор не создан</div>
        <div className="text-[13px] leading-relaxed text-muted">
          Логин и пароль выдаются при установке панели. Если установка прервалась, администратор
          создаётся в консоли сервера панели:
        </div>
        <code className="rounded-md bg-surface-2 px-3 py-2 font-mono text-[13px]">
          vps-panel admin init
        </code>
      </Card>
    </div>
  );
}

export function LoginPage() {
  const [step, setStep] = useState<'password' | 'totp' | 'enroll'>('password');
  const [enroll, setEnroll] = useState<TotpSetup | null>(null);
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
      const r = await api<{ next: 'totp' } | ({ next: 'enroll' } & TotpSetup)>('/api/auth/login', {
        method: 'POST',
        json: { login, password },
      });
      if (r.next === 'enroll') {
        // первый вход (или 2FA сброшена из консоли): настроить её сейчас
        setEnroll(r);
        setStep('enroll');
      } else setStep('totp');
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

  async function confirmEnroll(c: string) {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/enroll', { method: 'POST', json: { code: c } });
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
    // ?next=/api/proxy/open/... - пришли с поддомена панели сервиса: вернуться туда;
    // ?next=/servers/... - страница панели, открытая без сессии (ссылка из уведомления)
    const next = new URLSearchParams(location.search).get('next') ?? '';
    if (next.startsWith('/api/proxy/open/')) {
      location.href = next;
      return;
    }
    if (/^\/(?![/\\]|api\/|login)/.test(next)) {
      await navigate({ href: next });
      return;
    }
    await navigate({ to: '/' });
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card
        className={cn(
          'flex w-full flex-col gap-4.5 p-8',
          step === 'enroll' ? 'max-w-[520px]' : 'max-w-[400px]',
        )}
      >
        <Logo size={32} />
        {/* разные key: иначе React переиспользует форму и кнопку - "Назад" (пятый элемент) прямо
            во время клика становится "Дальше" (type=submit), браузер отправляет форму пароля, и
            экран кода открывается снова */}
        {step === 'enroll' && enroll ? (
          <div key="enroll" className="flex flex-col gap-4">
            <div>
              <div className="text-xl font-semibold">Двухфакторная аутентификация</div>
              <div className="mt-1 text-[13px] text-muted">
                Вход в панель только с 2FA. Подойдёт любое приложение-аутентификатор: Google
                Authenticator, Aegis, 1Password.
              </div>
            </div>
            <TotpEnroll
              setup={enroll}
              onConfirm={(c) => void confirmEnroll(c)}
              label="Включить 2FA и войти"
              busy={busy}
              error={error}
            />
            <Button
              variant="link"
              className="self-end text-[13px] text-muted hover:text-text"
              onClick={() => {
                setError(null);
                setStep('password');
              }}
            >
              Назад
            </Button>
          </div>
        ) : step === 'password' ? (
          <form key="password" onSubmit={submitPassword} className="flex flex-col gap-4">
            <div className="text-xl font-semibold">Вход</div>
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
                6&nbsp;цифр из приложения-аутентификатора или резервный код
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
