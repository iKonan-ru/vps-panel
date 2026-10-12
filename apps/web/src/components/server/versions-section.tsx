import { ActionOutput } from '@/components/action-output';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Section } from '@/components/ui/section';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { Download, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Итог проверки обновлений компонента (lib/service-updates.ts на сервере, versions). */
export interface ComponentVersion {
  latest: string;
  available: boolean;
  current?: string;
  detail?: string;
  error?: string;
  checkedAt?: string;
}

export type Versions<K extends string> = Partial<Record<K, ComponentVersion>>;

/**
 * Блок "Версии" вкладки сервиса (MTProxyL, 3X-UI): по строке на компонент - установленная и
 * последняя версии с проверки (раз в 6 часов, кнопкой, после обновления), кнопка обновления;
 * вывод идущего обновления - здесь же. Те же обновления видны в "Обзоре" и в списке серверов.
 * current в строке - живая версия с сервера (вкладка знает её точнее проверки); children -
 * свои строки блока (движок MTProxyL).
 */
export function VersionsSection<K extends string>({
  rows,
  data,
  checking,
  disabled,
  reason,
  onCheck,
  onUpdate,
  action,
  onHideAction,
  onActionFinished,
  children,
}: {
  rows: { kind: K; title: string; current?: string | undefined; hint?: string }[];
  data: Versions<K> | undefined;
  checking: boolean;
  disabled: boolean;
  reason: string | undefined;
  onCheck: () => void;
  onUpdate: (kind: K, latest: string) => void;
  /** Идущее или законченное обновление: вывод - в блоке, как в "Обзоре". */
  action: { id: string; title: string } | null;
  onHideAction: () => void;
  onActionFinished: () => void;
  children?: ReactNode;
}) {
  const checkedAt = rows
    .map((r) => data?.[r.kind]?.checkedAt ?? '')
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
          disabled={checking || disabled}
          onClick={onCheck}
          title="Проверить обновления"
          aria-label="Проверить обновления"
        >
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
        </Button>
      }
    >
      {action && (
        <div className="flex flex-col gap-2 border-b border-border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            {action.title}
            <div className="grow" />
            <Button size="sm" variant="ghost" onClick={onHideAction} label="Скрыть">
              <X className="size-3.5" />
            </Button>
          </div>
          <ActionOutput key={action.id} actionId={action.id} onFinished={onActionFinished} />
        </div>
      )}
      {rows.map(({ kind, title, current, hint }) => {
        const v = data?.[kind];
        const installed = current || v?.current || '?';
        return (
          <div
            key={kind}
            className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 grow">
              <div className="font-medium">
                {title}
                {v?.detail && <span className="ml-1.5 text-xs text-muted">{v.detail}</span>}
              </div>
              <div className="text-xs text-muted">
                {!v
                  ? `установлена ${installed}, обновления не проверялись`
                  : `установлена ${installed}${v.latest ? `, последняя ${v.latest}` : ''}`}
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
                title={reason ?? hint}
                onClick={() => onUpdate(kind, v.latest)}
              >
                <Download className="size-3.5" />
                Обновить<span className="hidden md:inline"> до {v.latest}</span>
              </Button>
            ) : (
              v && !v.error && <Chip tone="ok">последняя</Chip>
            )}
          </div>
        );
      })}
      {children}
    </Section>
  );
}
