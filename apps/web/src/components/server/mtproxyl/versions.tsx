import type { Versions } from '@/components/server/versions-section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { InfoTip } from '@/components/ui/info-tip';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useQuery } from '@tanstack/react-query';
import type { EngineInfo } from '@vps/protocol';
import { Download } from 'lucide-react';
import { useState } from 'react';

/** Версии MTProxyL и его веб-панели (блок - versions-section.tsx), выбор версии движка telemt. */

export type MtVersionKind = 'mtproxyl' | 'mtproxyl-panel';

export type MtVersions = Versions<MtVersionKind>;

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
  if (!data) return <div className="text-sm text-muted">Загрузка&hellip;</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1 text-[13px] text-muted">
        Обновлять движок необязательно
        <InfoTip>
          {data.binary
            ? 'Движок установлен бинарником: доступна любая версия'
            : 'Движок в docker: доступны только версии с готовым образом, сборка из исходников может повесить слабый сервер'}
        </InfoTip>
      </div>
      {data.registryError && (
        <Alert tone="bad">
          Реестр образов не ответил ({data.registryError}), наличие готовых образов неизвестно
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
              {v.prerelease && <Chip tone="muted">предварительная</Chip>}
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
          {tag ? `Установить ${tag}` : 'Версия не выбрана'}
        </Button>
      </div>
    </div>
  );
}
