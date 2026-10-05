import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { InfoTip } from '@/components/ui/info-tip';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Download, Layers, RefreshCw } from 'lucide-react';
import { useState } from 'react';

/** Версии MTProxyL и его веб-панели, движок (образ или бинарник) с обновлением и откатом. */

export type MtVersionKind = 'mtproxyl' | 'mtproxyl-panel';

/** Итог проверки обновлений компонента (lib/service-updates.ts на сервере). */
interface MtVersion {
  latest: string;
  available: boolean;
  current?: string;
  detail?: string;
  error?: string;
  checkedAt?: string;
}

export type MtVersions = Partial<Record<MtVersionKind, MtVersion>>;

/**
 * Версии MTProxyL и веб-панели с последней проверки (раз в 6 часов, кнопкой, после обновления)
 * и кнопки обновления - те же обновления видны в "Обзоре" и в списке серверов. Движок telemt -
 * не обновление: его версия меняется по желанию (EngineForm).
 */
export function VersionsSection({
  data,
  panel,
  engine,
  checking,
  disabled,
  reason,
  onCheck,
  onUpdate,
  onEngine,
}: {
  data: MtVersions | undefined;
  panel: boolean;
  engine: string | undefined;
  checking: boolean;
  disabled: boolean;
  reason: string | undefined;
  onCheck: () => void;
  onUpdate: (kind: MtVersionKind, latest: string) => void;
  onEngine: () => void;
}) {
  const rows: { kind: MtVersionKind; title: string }[] = [
    { kind: 'mtproxyl', title: 'MTProxyL' },
    ...(panel ? [{ kind: 'mtproxyl-panel' as const, title: 'Веб-панель' }] : []),
  ];
  const checkedAt = Object.values(data ?? {})
    .map((v) => v?.checkedAt ?? '')
    .sort()
    .pop();
  return (
    <Section
      title="Версии"
      extra={checkedAt && <span className="text-xs text-muted">проверено {ago(checkedAt)}</span>}
      actions={
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={checking}
          onClick={onCheck}
          title="Проверить обновления"
          aria-label="Проверить обновления"
        >
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
        </Button>
      }
    >
      {rows.map(({ kind, title }) => {
        const v = data?.[kind];
        return (
          <div
            key={kind}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 grow">
              <div className="font-medium">
                {title}
                {v?.detail && <span className="ml-1.5 text-xs text-muted">{v.detail}</span>}
              </div>
              <div className="text-xs text-muted">
                {!v
                  ? 'ещё не проверялось'
                  : `установлена ${v.current || '?'}${v.latest ? `, последняя ${v.latest}` : ''}`}
              </div>
              {v?.error && (
                <div className="break-words text-xs text-bad">проверка не удалась: {v.error}</div>
              )}
            </div>
            {v?.available ? (
              <Button
                size="sm"
                variant="primary"
                disabled={disabled}
                title={reason}
                onClick={() => onUpdate(kind, v.latest)}
              >
                <Download className="size-3.5" />
                Обновить до {v.latest}
              </Button>
            ) : (
              v && !v.error && <Chip tone="ok">последняя</Chip>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="min-w-0 grow">
          <div className="font-medium">Движок telemt</div>
          <div className="text-xs text-muted">установлена {engine || '?'}</div>
        </div>
        <Button size="sm" disabled={disabled} title={reason} onClick={onEngine}>
          <Layers className="size-3.5" />
          Сменить версию
        </Button>
      </div>
    </Section>
  );
}

interface EngineVersion {
  tag: string;
  date: string;
  prerelease: boolean;
  installed: boolean;
  image: boolean;
  ready: boolean;
}

interface EngineInfo {
  current: string;
  binary: boolean;
  versions: EngineVersion[];
  registryError?: string;
}

/**
 * Выбор версии движка telemt (lib/mtproxyl-engine.ts на сервере): ставятся только версии с
 * готовым образом в реестре или любые при носителе-бинарнике. Без готового образа MTProxyL
 * собирал бы движок из исходников на сервере - слабый сервер от этого может повиснуть.
 */
export function EngineForm({
  serverId,
  disabled,
  reason,
  onInstall,
}: {
  serverId: string;
  disabled: boolean;
  reason: string | undefined;
  onInstall: (tag: string) => void;
}) {
  const { data, error } = useQuery({
    queryKey: ['mtproxyl-engine', serverId],
    queryFn: () => api<EngineInfo>(`/api/servers/${serverId}/mtproxyl/engine`),
    gcTime: 0,
  });
  const [tag, setTag] = useState<string | null>(null);
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <div className="text-sm text-muted">Спрашиваю версии у сервера...</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1 text-[13px] text-muted">
        Обновлять движок необязательно.
        <InfoTip>
          Прокси работает на текущей версии.{' '}
          {data.binary
            ? 'Движок - бинарник: любая версия скачивается готовой.'
            : 'Движок - образ docker: доступны версии с готовым образом. Без него MTProxyL собирает движок из исходников на сервере - слабый сервер от этого может повиснуть, такие версии недоступны.'}
        </InfoTip>
      </div>
      {data.registryError && (
        <Alert tone="bad">
          Реестр образов не ответил ({data.registryError}): неизвестно, есть ли готовые образы.
          Попробуй позже.
        </Alert>
      )}
      <div className="flex flex-col rounded-lg border border-border">
        {data.versions.map((v) => (
          <label
            key={v.tag}
            className={cn(
              'flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0',
              (!v.ready || v.installed) && 'opacity-60',
            )}
          >
            <input
              type="radio"
              name="engine-version"
              className="accent-accent"
              checked={tag === v.tag}
              disabled={!v.ready || v.installed}
              onChange={() => setTag(v.tag)}
            />
            <span className="min-w-0 grow">
              <span className="font-mono text-[13px]">{v.tag}</span>
              <span className="ml-2 text-xs text-muted">{v.date}</span>
              {!v.ready && (
                <span className="block text-xs text-muted">
                  нет готового образа: нужна сборка на сервере
                </span>
              )}
            </span>
            <span className="flex flex-wrap justify-end gap-1">
              {v.installed && <Chip tone="ok">установлена</Chip>}
              {v.prerelease && <Chip tone="muted">pre-release</Chip>}
            </span>
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!tag || disabled}
          title={reason}
          onClick={() => tag && onInstall(tag)}
        >
          <Download className="size-3.5" />
          {tag ? `Поставить ${tag}` : 'Выбери версию'}
        </Button>
      </div>
    </div>
  );
}
