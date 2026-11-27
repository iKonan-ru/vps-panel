import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/ui/link-button';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useCopy } from '@/lib/use-copy';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SUB_APP, SUB_APPS, subApp } from '@vps/protocol';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * Подписка VLESS для выбранного приложения: ссылка импорта (открыть у себя или скопировать и
 * отправить человеку) и выбор приложения клиента - на его личной странице оно выбрано сразу.
 */
export function SubAppPicker({
  clientId,
  url,
  name,
  saved,
}: {
  clientId: string;
  url: string;
  name: string;
  /** Приложение клиента из карточки; нет - по умолчанию для ОС на личной странице. */
  saved: string | undefined;
}) {
  const qc = useQueryClient();
  const [pick, setPick] = useState(subApp(saved)?.id ?? DEFAULT_SUB_APP);
  const op = useAction();
  const { copied, copy } = useCopy();
  const app = subApp(pick);
  const mine = pick === subApp(saved)?.id;

  async function save() {
    await op.run(async () => {
      await api(`/api/gclients/${clientId}`, { method: 'PATCH', json: { apps: { vless: pick } } });
      await qc.invalidateQueries({ queryKey: ['gclient', clientId] });
    });
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <Tabs
        items={SUB_APPS.map((a) => ({
          id: a.id,
          title: a.id === subApp(saved)?.id ? `${a.name} (клиента)` : a.name,
        }))}
        value={pick}
        onChange={setPick}
      />
      {app?.link ? (
        <LinkButton
          href={app.link(url, name)}
          variant="primary"
          size="md"
          wide
          title={`Добавить подписку VLESS в ${app.name}`}
          copyText={app.link(url, name)}
          copyTitle={`Скопировать ссылку для ${app.name}`}
        >
          Добавить в {app.name}
        </LinkButton>
      ) : (
        <>
          <Button variant="primary" size="md" className="w-full" onClick={() => copy(url)}>
            {copied ? <Check className="size-4 animate-check" /> : <Copy className="size-4" />}
            Скопировать подписку
          </Button>
          {app?.hint && <p className="text-[13px] text-muted">{app.hint}</p>}
        </>
      )}
      {mine ? (
        <p className="text-[13px] text-muted">Приложение клиента: на его странице выбрано сразу</p>
      ) : (
        <Button size="sm" className="self-start" disabled={op.busy} onClick={() => void save()}>
          Сделать приложением клиента
        </Button>
      )}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
    </div>
  );
}
