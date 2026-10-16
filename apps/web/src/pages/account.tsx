import { MetricCard } from '@/components/server/metric-card';
import { BackupCodes, TotpEnroll, type TotpSetup } from '@/components/totp-enroll';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Num } from '@/components/ui/num';
import { PageTitle } from '@/components/ui/page-title';
import { Pager, usePaged } from '@/components/ui/pager';
import { PasswordInput } from '@/components/ui/password-input';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, dateShort } from '@/lib/format';
import { randomToken } from '@/lib/random';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, LogOut, RefreshCw, ShieldCheck, User, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';

interface Account {
  login: string;
  totpEnabled: boolean;
  backupCodesLeft: number;
  createdAt: string;
}

interface Security {
  failed24: number;
  failed7d: number;
  topIps: { ip: string; n: number; last: string }[];
  recent: { ip: string; login: string; ok: boolean; at: string }[];
  sessions: {
    id: string;
    ip: string;
    userAgent: string;
    createdAt: string;
    expiresAt: string;
    current: boolean;
  }[];
}

const PASSWORD_MIN = 12;
function Row({
  icon,
  title,
  value,
  action,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
        {icon}
      </div>
      <div className="min-w-0 grow">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="truncate text-xs text-muted">{value}</div>
      </div>
      {action}
    </div>
  );
}

function LoginDialog({ current, onClose }: { current: string; onClose: () => void }) {
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

function PasswordDialog({ onClose }: { onClose: () => void }) {
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

function TotpDialog({ onClose }: { onClose: () => void }) {
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

function CodesDialog({ onClose }: { onClose: () => void }) {
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

/**
 * Аккаунт: логин, пароль, 2FA и резервные коды администратора; безопасность входа - попытки,
 * откуда ломятся, сессии. Восстановления пароля нет: сброс - vps-panel admin в консоли сервера.
 */
export function AccountPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ask = useConfirm();
  const logoutAll = useAction();
  const closing = useAction();
  const [dialog, setDialog] = useState<'login' | 'password' | 'totp' | 'codes' | null>(null);
  const acc = useQuery({ queryKey: ['account'], queryFn: () => api<Account>('/api/account') });
  const sec = useQuery({
    queryKey: ['security'],
    queryFn: () => api<Security>('/api/security'),
    refetchInterval: 60_000,
  });
  const { data: servers } = useServers();
  const panelHost = typeof location !== 'undefined' ? location.hostname : '';
  // Сервер, на котором стоит панель: его jail vps-panel показывает баны fail2ban.
  const panelServer = servers?.find((s) => s.panelHost);
  const panelJail = panelServer?.audit?.jails.find((j) => j.name === 'vps-panel');
  const a = acc.data;
  const d = sec.data;
  const recent = usePaged(d?.recent ?? []);
  const busy = acc.isFetching || !a;

  async function closeSession(id: string, current: boolean) {
    const ok = await ask({
      title: current ? 'Выйти на этом устройстве?' : 'Закрыть сессию?',
      text: current
        ? 'Это текущая сессия: откроется страница входа.'
        : 'Устройство выйдет из панели.',
      okLabel: current ? 'Выйти' : 'Закрыть',
      danger: true,
    });
    if (!ok) return;
    const done = await closing.run(async () => {
      await api(`/api/account/sessions/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['security'] });
    });
    if (done && current) {
      qc.setQueryData(['me'], null);
      await navigate({ to: '/login' });
    }
  }

  return (
    <>
      <PageTitle>Аккаунт</PageTitle>

      <Section
        title="Вход в панель"
        info="Сброс пароля и 2FA только из консоли сервера панели: vps-panel admin password, vps-panel admin 2fa. Все сессии при этом закрываются."
      >
        <Row
          icon={<User className="size-4" />}
          title="Логин"
          value={a ? a.login : '\u2026'}
          action={
            <Button size="sm" disabled={busy} onClick={() => setDialog('login')}>
              Изменить
            </Button>
          }
        />
        <Row
          icon={<KeyRound className="size-4" />}
          title="Пароль"
          value="сброс только из консоли сервера"
          action={
            <Button size="sm" disabled={busy} onClick={() => setDialog('password')}>
              Изменить
            </Button>
          }
        />
        <Row
          icon={<ShieldCheck className="size-4" />}
          title="Двухфакторная аутентификация"
          value={
            a ? (
              <span className="inline-flex items-center gap-2">
                <Chip tone={a.totpEnabled ? 'ok' : 'warn'}>
                  {a.totpEnabled ? 'включена' : 'не настроена'}
                </Chip>
                <span>
                  резервных кодов: {a.backupCodesLeft}
                  {a.backupCodesLeft <= 2 ? ', пора создать новые' : ''}
                </span>
              </span>
            ) : (
              '\u2026'
            )
          }
          action={
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" disabled={busy} onClick={() => setDialog('codes')}>
                Новые коды
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setDialog('totp')}>
                Перенастроить
              </Button>
            </div>
          }
        />
      </Section>

      {dialog === 'login' && a && <LoginDialog current={a.login} onClose={() => setDialog(null)} />}
      {dialog === 'password' && <PasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'totp' && <TotpDialog onClose={() => setDialog(null)} />}
      {dialog === 'codes' && <CodesDialog onClose={() => setDialog(null)} />}

      <div className="grid gap-3 sm:grid-cols-3 md:gap-4">
        <MetricCard
          label={
            <span className="flex items-center gap-1">
              Неудачных входов за сутки
              <InfoTip>
                После 5&nbsp;неудачных попыток вход приостанавливается на 15&nbsp;мин. После
                5&nbsp;неудач за 15&nbsp;мин fail2ban банит IP на 1&nbsp;ч.
              </InfoTip>
            </span>
          }
          value={d ? <Num value={d.failed24} /> : '-'}
          tone={(d?.failed24 ?? 0) > 20 ? 'warn' : undefined}
          note={`за 7\u00a0дней: ${d?.failed7d ?? '-'}`}
        />
        <MetricCard
          label="fail2ban: jail vps-panel"
          value={panelJail ? <Num value={panelJail.banned} /> : '-'}
          unit="забанено сейчас"
          tone={(panelJail?.banned ?? 0) > 0 ? 'warn' : undefined}
          note={
            panelJail
              ? `всего банов ${panelJail.totalBanned}, в окне ${panelJail.failed} неудачных`
              : `нет данных: нужен свежий агент на ${panelHost} и включённый jail vps-panel`
          }
        />
        <MetricCard
          label={
            <span className="flex items-center gap-1">
              Активных сессий
              <InfoTip>Выход на всех устройствах закрывает и эту сессию</InfoTip>
            </span>
          }
          value={d ? <Num value={d.sessions.length} /> : '-'}
          note="вместе с этой"
          action={
            <Button
              variant="link"
              className="text-xs"
              disabled={logoutAll.busy}
              title="Выйти на всех устройствах"
              aria-label="Выйти на всех устройствах"
              onClick={async () => {
                const ok = await ask({
                  title: 'Выйти на всех устройствах?',
                  text: 'Все сессии панели закроются, включая эту.',
                  okLabel: 'Выйти везде',
                  danger: true,
                });
                if (!ok) return;
                const done = await logoutAll.run(() =>
                  api('/api/auth/logout-all', { method: 'POST' }),
                );
                if (!done) return;
                qc.setQueryData(['me'], null);
                await navigate({ to: '/login' });
              }}
            >
              <LogOut className="size-3.5 md:size-3" />
              <span className="hidden md:inline">Выйти везде</span>
            </Button>
          }
        >
          {logoutAll.error && <Alert tone="bad">{logoutAll.error}</Alert>}
        </MetricCard>
      </div>

      <Section title="Активные сессии">
        {closing.error && (
          <div className="px-4 pt-3">
            <Alert tone="bad">{closing.error}</Alert>
          </div>
        )}
        <Table>
          <THead>
            <tr>
              <th>Открыта</th>
              <th>IP</th>
              <th>Браузер</th>
              <th>Истекает</th>
              <th />
            </tr>
          </THead>
          <TBody>
            {(d?.sessions ?? []).map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap text-muted">
                  {ago(s.createdAt)}
                  {s.current && (
                    <Chip tone="accent" className="ml-2">
                      эта
                    </Chip>
                  )}
                </td>
                <td className="font-mono">{s.ip}</td>
                <td className="max-w-[420px] truncate text-muted" title={s.userAgent}>
                  {s.userAgent}
                </td>
                <td className="whitespace-nowrap text-muted">{dateShort(s.expiresAt)}</td>
                <td className="text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={closing.busy || sec.isFetching}
                    title={s.current ? 'Выйти на этом устройстве' : 'Закрыть сессию'}
                    aria-label={s.current ? 'Выйти на этом устройстве' : 'Закрыть сессию'}
                    onClick={() => void closeSession(s.id, s.current)}
                  >
                    <X className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
      </Section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section
          title="Неудачные попытки по IP"
          extra={<span className="text-xs text-muted">за 7&nbsp;дней</span>}
        >
          <Table>
            <THead>
              <tr>
                <th>IP</th>
                <th>Попыток</th>
                <th>Последняя</th>
              </tr>
            </THead>
            <TBody>
              {(d?.topIps ?? []).map((r) => (
                <tr key={r.ip}>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.n}</td>
                  <td className="text-muted">{ago(r.last)}</td>
                </tr>
              ))}
              {d && d.topIps.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-muted">
                    Неудачных попыток не было
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
        </Section>
        <Section title="Последние попытки входа">
          <Table>
            <THead>
              <tr>
                <th>Когда</th>
                <th>IP</th>
                <th>Логин</th>
                <th>Итог</th>
              </tr>
            </THead>
            <TBody>
              {recent.items.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="whitespace-nowrap text-muted">{ago(r.at)}</td>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.login}</td>
                  <td>{r.ok ? <Chip tone="ok">вход</Chip> : <Chip tone="bad">отказ</Chip>}</td>
                </tr>
              ))}
              {d && d.recent.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted">
                    Попыток пока нет
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
          <Pager {...recent} />
        </Section>
      </div>
    </>
  );
}
