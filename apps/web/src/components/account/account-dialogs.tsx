import { BackupCodes, TotpEnroll, type TotpSetup } from '@/components/totp-enroll';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { api } from '@/lib/api';
import { randomToken } from '@/lib/random';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { type FormEvent, useState } from 'react';

const PASSWORD_MIN = 12;

export function LoginDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const qc = useQueryClient();
  const act = useAction();
  const [login, setLogin] = useState(current);
  const [password, setPassword] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act.run(async () => {
      await api('/api/account/login', { method: 'PUT', json: { login, password } });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account'] }),
        qc.invalidateQueries({ queryKey: ['me'] }),
      ]);
    });
    if (ok) onClose();
  }
  return (
    <Dialog open onClose={onClose} title="Сменить логин">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Новый логин" htmlFor="acc-login">
          <Input
            id="acc-login"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value.replace(/\s/g, ''))}
            minLength={3}
            maxLength={32}
            required
            autoFocus
          />
        </Field>
        <Field label="Текущий пароль" htmlFor="acc-login-pw">
          <PasswordInput
            id="acc-login-pw"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {act.error && <Alert tone="bad">{act.error}</Alert>}
        <Button type="submit" variant="primary" disabled={act.busy || login === current}>
          Сохранить
        </Button>
      </form>
    </Dialog>
  );
}

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const act = useAction();
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== next2) return act.setError('Новые пароли не совпадают');
    const ok = await act.run(async () => {
      await api('/api/account/password', {
        method: 'PUT',
        json: { password, newPassword: next },
      });
      await qc.invalidateQueries({ queryKey: ['security'] });
    });
    if (ok) setDone(true);
  }
  if (done)
    return (
      <Dialog open onClose={onClose} title="Пароль изменён">
        <div className="text-[13px] text-muted">
          Остальные устройства вышли из панели, эта сессия осталась
        </div>
        <Button variant="primary" onClick={onClose}>
          Закрыть
        </Button>
      </Dialog>
    );
  return (
    <Dialog open onClose={onClose} title="Сменить пароль">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Текущий пароль" htmlFor="acc-pw">
          <PasswordInput
            id="acc-pw"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field
          label="Новый пароль"
          htmlFor="acc-pw-new"
          hint={`не короче ${PASSWORD_MIN}\u00a0символов`}
        >
          <div className="flex gap-2">
            <PasswordInput
              id="acc-pw-new"
              autoComplete="new-password"
              className="grow"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              minLength={PASSWORD_MIN}
              maxLength={200}
              required
            />
            <Button
              title="Сгенерировать случайный пароль"
              onClick={() => {
                const p = randomToken();
                setNext(p);
                setNext2(p);
              }}
            >
              <RefreshCw className="size-3.5" />
              <span className="hidden sm:inline">Случайный</span>
            </Button>
          </div>
        </Field>
        <Field label="Новый пароль ещё раз" htmlFor="acc-pw-new2">
          <PasswordInput
            id="acc-pw-new2"
            autoComplete="new-password"
            value={next2}
            onChange={(e) => setNext2(e.target.value)}
            required
          />
        </Field>
        <div className="text-xs text-muted">
          Восстановления пароля нет, сброс только из консоли сервера панели: vps-panel admin
          password. Другие устройства выйдут из панели.
        </div>
        {act.error && <Alert tone="bad">{act.error}</Alert>}
        <Button type="submit" variant="primary" disabled={act.busy}>
          Сменить пароль
        </Button>
      </form>
    </Dialog>
  );
}

export function TotpDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const start = useAction();
  const confirm = useAction();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await start.run(async () => {
      setSetup(
        await api<TotpSetup>('/api/account/totp', { method: 'POST', json: { password, code } }),
      );
    });
  }
  async function finish(c: string) {
    const ok = await confirm.run(async () => {
      await api('/api/account/totp/confirm', { method: 'POST', json: { code: c } });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account'] }),
        qc.invalidateQueries({ queryKey: ['security'] }),
      ]);
    });
    if (ok) onClose();
  }
  return (
    <Dialog open onClose={onClose} title="Перенастроить 2FA">
      {setup ? (
        <>
          <div className="text-[13px] text-muted">
            Старые резервные коды перестанут действовать. До подтверждения работает прежняя 2FA.
          </div>
          <TotpEnroll
            setup={setup}
            onConfirm={(c) => void finish(c)}
            label="Включить новую 2FA"
            busy={confirm.busy}
            error={confirm.error}
          />
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Текущий пароль" htmlFor="acc-totp-pw">
            <PasswordInput
              id="acc-totp-pw"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="Код из приложения или резервный" htmlFor="acc-totp-code">
            <Input
              id="acc-totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 12))}
              required
            />
          </Field>
          {start.error && <Alert tone="bad">{start.error}</Alert>}
          <Button type="submit" variant="primary" disabled={start.busy}>
            Дальше
          </Button>
        </form>
      )}
    </Dialog>
  );
}

export function CodesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const act = useAction();
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await act.run(async () => {
      const r = await api<{ backupCodes: string[] }>('/api/account/backup-codes', {
        method: 'POST',
        json: { password },
      });
      setCodes(r.backupCodes);
      await qc.invalidateQueries({ queryKey: ['account'] });
    });
  }
  return (
    <Dialog open onClose={onClose} title="Новые резервные коды">
      {codes ? (
        <>
          <div className="text-[13px] text-muted">
            Каждый код годится для одного входа без телефона. Коды показываются один раз, прежние
            больше не действуют.
          </div>
          <BackupCodes codes={codes} />
          <Button variant="primary" onClick={onClose}>
            Закрыть
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="text-[13px] text-muted">Новые 8&nbsp;кодов заменят все прежние</div>
          <Field label="Текущий пароль" htmlFor="acc-codes-pw">
            <PasswordInput
              id="acc-codes-pw"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </Field>
          {act.error && <Alert tone="bad">{act.error}</Alert>}
          <Button type="submit" variant="primary" disabled={act.busy}>
            Создать коды
          </Button>
        </form>
      )}
    </Dialog>
  );
}
