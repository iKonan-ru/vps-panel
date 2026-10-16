import { AppLinkButton } from '@/components/app-links';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageTitle } from '@/components/ui/page-title';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { type AppsList, useApps } from '@/lib/apps';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';

/** Клиентские приложения по сервисам и ОС: ссылки открыть или скопировать для клиента. */
export function AppsPage() {
  const qc = useQueryClient();
  const { data, error } = useApps();
  const op = useAction();

  async function refresh() {
    await op.run(async () => {
      qc.setQueryData(['apps'], await api<AppsList>('/api/apps/refresh', { method: 'POST' }));
    });
  }

  return (
    <>
      {/* кнопка всегда справа; подпись, которой не хватает места, - строкой ниже */}
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 grow flex-wrap items-center gap-x-3 gap-y-1">
          <PageTitle>Приложения</PageTitle>
          {data?.checkedAt && (
            <span className="text-xs text-muted">версии проверены {ago(data.checkedAt)}</span>
          )}
        </div>
        <Button
          size="sm"
          disabled={op.busy}
          onClick={() => void refresh()}
          label="Проверить версии"
        >
          <RefreshCw className={cn('size-3.5', op.busy && 'animate-spin')} />
        </Button>
      </div>
      {error && <Alert tone="bad">{error.message}</Alert>}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      {data?.apps.map((app) => (
        <Section
          key={app.id}
          title={app.name}
          extra={<span className="text-xs text-muted">{app.purpose}</span>}
        >
          {app.platforms.map((p) => (
            <div
              key={p.os}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="w-28 shrink-0 text-[13px] font-medium">{p.title}</div>
              <div className="flex min-w-0 grow flex-wrap items-center gap-2">
                {/* кнопка не сжимается; пояснение, которому не хватает места, - строкой ниже,
                    а не поверх кнопки */}
                {p.links.map((l) => (
                  <span key={l.url} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="shrink-0">
                      <AppLinkButton link={l} />
                    </span>
                    {l.note && <span className="min-w-0 text-xs text-muted">{l.note}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Section>
      ))}
    </>
  );
}
