import type { XuiInfo } from '@/components/server/xui-model';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { randomToken } from '@/lib/random';
import { type FormEvent, useState } from 'react';

export function SettingsForm({
  info,
  busy,
  onSubmit,
}: {
  info: XuiInfo;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const ask = useConfirm();
  const [port, setPort] = useState(String(info.panelPort));
  const [basePath, setBasePath] = useState(info.basePath.replace(/^\/|\/$/g, ''));
  const [listen, setListen] = useState(info.listen === '0.0.0.0' ? '' : info.listen);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reset2fa, setReset2fa] = useState(false);

  const body: Record<string, unknown> = {};
  if (Number(port) !== info.panelPort) body.port = Number(port);
  if (basePath !== info.basePath.replace(/^\/|\/$/g, '')) body.basePath = basePath;
  if ((listen || '0.0.0.0') !== (info.listen || '0.0.0.0')) body.listen = listen || '0.0.0.0';
  if (username.trim()) body.username = username.trim();
  if (password) body.password = password;
  if (reset2fa) body.resetTwoFactor = true;
  const changed = Object.keys(body).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    if (body.port || body.basePath) {
      const ok = await ask({
        title: 'Изменить порт или путь панели?',
        text: 'Старая ссылка перестанет работать, port-sync откроет новый порт',
        okLabel: 'Изменить',
      });
      if (!ok) return;
    }
    onSubmit(body);
  };

  return (
    <Section title="Настройки панели">
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Порт панели" htmlFor="xui-port">
            <Input
              id="xui-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </Field>
          <Field label="Listen IP" htmlFor="xui-listen">
            <Input
              id="xui-listen"
              value={listen}
              onChange={(e) => setListen(e.target.value)}
              placeholder="0.0.0.0"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Путь панели" htmlFor="xui-path">
          <div className="flex gap-2">
            <Input
              id="xui-path"
              value={basePath}
              onChange={(e) => setBasePath(e.target.value)}
              className="font-mono"
              pattern="[A-Za-z0-9_-]{0,64}"
            />
            <Button
              onClick={() => setBasePath(randomToken(18))}
              title="Длинный случайный путь скрывает панель от сканеров"
            >
              Сгенерировать
            </Button>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Новый логин" htmlFor="xui-user">
            <Input
              id="xui-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="без изменений"
              autoComplete="off"
            />
          </Field>
          <Field label="Новый пароль" htmlFor="xui-pass">
            <Input
              id="xui-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="задан"
              autoComplete="new-password"
            />
          </Field>
        </div>
        {info.twoFactor && (
          <Checkbox
            label="Сбросить 2FA"
            checked={reset2fa}
            onChange={(e) => setReset2fa(e.target.checked)}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">После сохранения 3X-UI перезапустится</span>
          <div className="grow" />
          <Button type="submit" variant="primary" disabled={busy || !changed}>
            Сохранить
          </Button>
        </div>
      </form>
    </Section>
  );
}
