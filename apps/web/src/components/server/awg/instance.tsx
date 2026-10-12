import {
  type AwgClient,
  type AwgInstance,
  clientTitle,
  isOnline,
  versionTitles,
} from '@/components/server/awg/model';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/cn';
import type { GOwner } from '@vps/protocol';
import { deviceOf } from '@vps/protocol';
import { Plus, UserRound } from 'lucide-react';
import { Fragment, useState } from 'react';

export function Instance({
  inst,
  onClient,
  onAdd,
  addDisabled,
  addTitle,
  onSetParams,
  onUninstall,
  owner,
}: {
  inst: AwgInstance;
  /** Клиент панели, чей это пир (по ключу), - значок на плитке. */
  owner: (publicKey: string) => GOwner | undefined;
  onClient: (c: AwgClient) => void;
  onAdd: () => void;
  addDisabled: boolean;
  addTitle: string | undefined;
  /** Смена параметров экземпляра; ошибка - текстом (показывается в окне параметров). */
  onSetParams: (profile: string) => Promise<string | null>;
  /** Удаление экземпляра: команда каталога с этим контейнером (план и подтверждение - там). */
  onUninstall: () => void;
}) {
  const uninstall = (
    <Button
      variant="link"
      className="text-xs text-bad"
      disabled={addDisabled}
      title={addTitle ?? 'Клиенты экземпляра удалятся вместе с ним'}
      onClick={onUninstall}
    >
      Удалить экземпляр
    </Button>
  );
  const [showParams, setShowParams] = useState(false);
  const [changing, setChanging] = useState(false);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const legacy = inst.container === 'amnezia-awg';
  const current = inst.version.startsWith('3') ? '3.1' : inst.version === '2.0' ? '2.0' : '1.0';
  const [profile, setProfile] = useState(legacy ? '1.0' : current);
  const onlineCount = inst.clients.filter(isOnline).length;
  // адрес, порт и ключ показаны в сводке; в таблице - только параметры протокола
  const params = inst.params.filter((p) => !['Address', 'ListenPort'].includes(p.key));
  const impl =
    inst.impl === 'go' ? 'amneziawg-go' : inst.impl === 'kernel' ? 'модуль ядра' : 'не определена';
  return (
    <Section
      title={<span className="font-mono">{inst.container}</span>}
      extra={
        <>
          {inst.version && (
            <Chip tone="accent" title="Версия протокола по параметрам конфига">
              {versionTitles[inst.version] ?? inst.version}
            </Chip>
          )}
          {inst.state !== 'running' && <Chip tone="bad">{inst.state}</Chip>}
        </>
      }
      actions={
        !inst.error && (
          <Button
            size="sm"
            variant="primary"
            disabled={addDisabled}
            title={addTitle}
            onClick={onAdd}
            label="Добавить клиента"
          >
            <Plus className="size-3.5" />
          </Button>
        )
      }
    >
      {inst.error ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <Alert tone="bad" className="self-stretch">
            {inst.error}
          </Alert>
          {uninstall}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-border px-4 py-3 text-[13px] sm:grid-cols-4">
            <Fact label="Порт" value={inst.port ? `${inst.port}/udp` : '-'} />
            <Fact label="Подсеть" value={inst.address || '-'} />
            <Fact label="Клиенты" value={`${inst.clients.length}, онлайн: ${onlineCount}`} />
            <Fact label="Реализация" value={impl} title={inst.tools} />
          </dl>
          {inst.tableError && (
            <div className="px-4 pt-3">
              <Alert tone="info">{inst.tableError}</Alert>
            </div>
          )}
          {inst.clients.length === 0 ? (
            <div className="px-4 py-4 text-center text-[13px] text-muted">Клиентов нет</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
              {inst.clients.map((c) => {
                const on = isOnline(c);
                const panel = owner(c.publicKey);
                const state =
                  c.disabled || !c.inConfig ? 'выключен' : on ? 'на связи' : 'не на связи';
                return (
                  <button
                    key={c.publicKey}
                    type="button"
                    title={`${state}${panel ? `, клиент панели ${panel.client}` : ''}`}
                    onClick={() => onClient(c)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent',
                      (c.disabled || !c.inConfig) && 'opacity-60',
                    )}
                  >
                    <span
                      aria-label={state}
                      className={cn('size-2.5 shrink-0 rounded-full', on ? 'bg-ok' : 'bg-muted')}
                    />
                    {/* одна обрезка на двоих: не хватает места - первым сокращается устройство */}
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-[13px]">{clientTitle(c)}</span>
                      {deviceOf(c.device) && (
                        <span className="ml-1.5 text-xs text-muted">
                          {deviceOf(c.device)?.title}
                        </span>
                      )}
                    </span>
                    {panel && (
                      <UserRound
                        className="size-3.5 shrink-0 text-accent"
                        aria-label={`клиент панели ${panel.client}`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="border-t border-border px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <Button variant="link" className="text-xs" onClick={() => setShowParams(!showParams)}>
                {showParams ? 'Скрыть параметры' : `Параметры протокола (${params.length})`}
              </Button>
              {uninstall}
            </div>
            {showParams && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
                {params.map((p) => (
                  <Fragment key={p.key}>
                    <dt className="text-muted">{p.key}</dt>
                    <dd className="min-w-0 break-all">
                      {p.value}
                      {p.commented && (
                        <span className="ml-2 font-sans text-muted">(только для клиентов)</span>
                      )}
                    </dd>
                  </Fragment>
                ))}
                <dt className="text-muted">Конфиг</dt>
                <dd className="min-w-0 break-all">{inst.confPath}</dd>
                <dt className="text-muted">Ключ сервера</dt>
                <dd className="min-w-0 break-all">{inst.publicKey || '-'}</dd>
              </dl>
            )}
            {showParams && (
              <Button
                variant="link"
                className="mt-2 text-xs"
                disabled={addDisabled}
                title={addTitle}
                onClick={() => {
                  setParamsError(null);
                  setChanging(true);
                }}
              >
                Сменить версию или перевыпустить параметры
              </Button>
            )}
            <Dialog
              open={changing}
              onClose={() => setChanging(false)}
              title={`Параметры ${inst.container}`}
            >
              <div className="text-[13px]">
                Ключ сервера, порт, подсеть и клиенты сохранятся, но{' '}
                <b>клиенты не подключатся, пока не импортируют новый конфиг</b>. Новые конфиги
                &mdash; в окне клиента, в приложении Amnezia нужно переподключить сервер. При ошибке
                вернутся прежние параметры.
              </div>
              <Field
                label="Версия"
                htmlFor={`awg-profile-${inst.container}`}
                hint={
                  legacy
                    ? 'контейнер amnezia-awg поддерживает только 1.0, для новых версий нужен новый экземпляр'
                    : undefined
                }
              >
                <Select
                  id={`awg-profile-${inst.container}`}
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                >
                  <option value="3.1" disabled={legacy}>
                    3.1 (последняя)
                  </option>
                  <option value="2.0" disabled={legacy}>
                    2.0 (для клиентов до 3.x)
                  </option>
                  <option value="1.0">1.0 (для старых клиентов и роутеров)</option>
                </Select>
              </Field>
              {paramsError && <Alert tone="bad">{paramsError}</Alert>}
              <div className="flex justify-end gap-2">
                <Button onClick={() => setChanging(false)}>Отмена</Button>
                <Button
                  variant="danger"
                  disabled={addDisabled}
                  onClick={async () => {
                    const err = await onSetParams(profile);
                    if (err) setParamsError(err);
                    else setChanging(false);
                  }}
                >
                  {profile === current ? 'Перевыпустить параметры' : `Перейти на ${profile}`}
                </Button>
              </div>
            </Dialog>
          </div>
        </>
      )}
    </Section>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}
