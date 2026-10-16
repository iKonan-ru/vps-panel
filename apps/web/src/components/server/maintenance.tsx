import { ActionOutput } from '@/components/action-output';
import { BannedIps } from '@/components/server/banned-ips';
import { BaselineDialog } from '@/components/server/baseline-dialog';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { LinkButton } from '@/components/ui/link-button';
import { Section } from '@/components/ui/section';
import { TBody, Table } from '@/components/ui/table';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { useCommands } from '@/lib/commands';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { type ServiceUpdateKind, startServiceUpdate, useUpdatesCheck } from '@/lib/service-update';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import type { Finding } from '@vps/protocol';
import { ArrowRight, ClipboardCheck, Download, Trash2, Wrench, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** Обновление установленного сервиса (проверяет панель раз в 6 часов). */
interface ServiceUpdate {
  kind: ServiceUpdateKind;
  title: string;
  current: string;
  latest: string;
}

interface SecurityRow {
  key: string;
  chip: ReactNode;
  text: string;
  hint?: string | undefined;
  action: ReactNode;
}

function SeverityChip({ severity }: { severity: Finding['severity'] }) {
  return (
    <Chip tone={severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'muted'}>
      {severity === 'high' ? 'критично' : severity === 'medium' ? 'средне' : 'к сведению'}
    </Chip>
  );
}

/**
 * Блок "Обслуживание" вкладки "Обзор": обновления сервисов и пакетов, замечания аудита с
 * исправлением, баны fail2ban.
 */
export function Maintenance({
  s,
  onTab,
  onCleanup,
}: {
  s: ServerDetail;
  onTab?: ((tab: string) => void) | undefined;
  /** Окно очистки диска - общее с карточкой "Диск". */
  onCleanup: () => void;
}) {
  const commands = useCommands();
  // диалог исправления: null - закрыт, '' - все шаги, иначе - шаг из замечания
  const [baseline, setBaseline] = useState<string | null>(null);
  // запущенное из блока "Обслуживание" действие с выводом: обновление пакетов или сервиса
  // done - действие завершилось: вывод остаётся на экране, но кнопки снова доступны (повтор
  // после ошибки, например apt был занят автообновлениями)
  const [upgrade, setUpgrade] = useState<{
    id: string;
    title: string;
    done?: boolean;
  } | null>(null);
  const pending = s.audit?.pendingUpdates ?? 0;

  // запуск из "Обслуживания": пока идёт запрос, все кнопки блока заблокированы (двойной тап,
  // соседняя строка)
  const starting = useAction();
  async function startUpgrade() {
    await starting.run(async () => {
      const r = await actions.upgrade(s.id);
      setUpgrade({ id: r.actionId, title: 'Обновление пакетов' });
    });
  }
  // версии в ключе: после обновления инвентарь меняется, и список перезапрашивается
  const versions = s.services.map((v) => `${v.kind}:${v.version ?? ''}`).join(',');
  const { data: svcUpdates, isFetching: svcFetching } = useQuery({
    queryKey: ['service-updates', s.id, versions],
    queryFn: () => api<ServiceUpdate[]>(`/api/servers/${s.id}/updates`),
    refetchInterval: 10 * 60_000,
  });
  // после обновления сервиса версии перепроверяются (lib/live.ts)
  const updatesCheck = useUpdatesCheck(s.id);
  async function updateService(u: ServiceUpdate) {
    await starting.run(async () => {
      const r = await startServiceUpdate[u.kind](s.id);
      setUpgrade({ id: r.actionId, title: `Обновление ${u.title} до ${u.latest}` });
    });
  }
  const findings = s.audit?.findings ?? [];
  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны
  const lock = serverLock(s);
  const canAct = online && !lock.busy;
  // есть ли замечания, которые чинит агент (url вида fix:<шаг>)
  const fixable = findings.filter((f) => f.url?.startsWith('fix:')).length;

  // Строки блока "Обслуживание": у каждой одна кнопка действия справа
  // идёт запуск, своё действие с выводом или перепроверка версий - кнопки блока недоступны
  const busy =
    !canAct ||
    (upgrade !== null && !upgrade.done) ||
    starting.busy ||
    svcFetching ||
    updatesCheck.checking;
  const rows: SecurityRow[] = [
    ...(svcUpdates ?? []).map((u) => ({
      key: `update-${u.kind}`,
      chip: <Chip tone="update">обновление</Chip>,
      text: `${u.title}: доступна версия ${u.latest}`,
      hint: u.current ? `установлена ${u.current}` : undefined,
      action: (
        <Button
          size="sm"
          disabled={busy}
          title={lock.reason}
          onClick={() => updateService(u)}
          label="Обновить"
        >
          <Download className="size-3.5" />
        </Button>
      ),
    })),
    ...(pending > 0
      ? [
          {
            key: 'pending-updates',
            chip: <SeverityChip severity="medium" />,
            text: `Ожидают установки обновления безопасности: ${pending}`,
            hint: 'apt upgrade без docker и ядра',
            action: (
              <Button
                size="sm"
                disabled={busy}
                title={lock.reason}
                onClick={startUpgrade}
                label="Обновить"
              >
                <Download className="size-3.5" />
              </Button>
            ),
          },
        ]
      : []),
    // строку про пакеты агент пишет без действия - её заменяет строка выше
    ...findings
      .filter((f) => !(pending > 0 && !f.url && f.text.startsWith('Ожидают установки обновлени')))
      .map((f) => ({
        key: f.text,
        chip: <SeverityChip severity={f.severity} />,
        text: f.text,
        hint: f.fix,
        action: findingAction(f),
      })),
  ];

  /** Кнопка замечания аудита по его url: fix:, cleanup:, tab:, cmd: (команда каталога) или ссылка. */
  function findingAction(f: Finding) {
    const url = f.url ?? '';
    if (url.startsWith('cmd:')) {
      if (!commands.data?.some((c) => c.id === url.slice(4))) return null;
      return (
        <ButtonLink
          to="/commands/$id"
          params={{ id: url.slice(4) }}
          search={{ server: s.id, run: undefined, tab: undefined }}
          size="sm"
          label="Исправить"
        >
          <Wrench className="size-3.5" />
        </ButtonLink>
      );
    }
    if (url.startsWith('fix:'))
      return (
        <Button
          size="sm"
          disabled={!canAct}
          title={lock.reason}
          onClick={() => setBaseline(url.slice(4))}
          label="Исправить"
        >
          <Wrench className="size-3.5" />
        </Button>
      );
    if (url === 'cleanup:')
      return (
        <Button
          size="sm"
          disabled={!canAct}
          title={lock.reason}
          onClick={onCleanup}
          label="Очистить"
        >
          <Trash2 className="size-3.5" />
        </Button>
      );
    if (url.startsWith('tab:'))
      return (
        <Button size="sm" onClick={() => onTab?.(url.slice(4))} label="Открыть">
          <ArrowRight className="size-3.5" />
        </Button>
      );
    if (url) return <LinkButton href={url} label="Открыть" />;
    return null;
  }

  return (
    <>
      <Section
        title={
          <span className="inline-flex items-center gap-2">
            <ClipboardCheck className="size-4 text-muted" />
            Обслуживание
          </span>
        }
        info="Перед исправлением показывается, что изменится"
        extra={
          <>
            {high > 0 && <Chip tone="bad">критичных: {high}</Chip>}
            {medium > 0 && <Chip tone="warn">средних: {medium}</Chip>}
          </>
        }
        actions={
          <ActionBar
            actions={[
              {
                key: 'fix',
                label: `Исправить всё: ${fixable}`,
                short: `Исправить: ${fixable}`,
                icon: <Wrench className="size-3.5" />,
                variant: 'primary',
                hidden: fixable === 0,
                disabled: !canAct,
                title: lock.reason,
                onClick: () => setBaseline(''),
              },
            ]}
          />
        }
      >
        {starting.error && (
          <div className="px-4 pt-3">
            <Alert tone="bad">{starting.error}</Alert>
          </div>
        )}
        {upgrade && (
          <div className="flex flex-col gap-2 border-b border-border p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              {upgrade.title}
              <div className="grow" />
              <Button size="sm" variant="ghost" onClick={() => setUpgrade(null)} label="Скрыть">
                <X className="size-3.5" />
              </Button>
            </div>
            <ActionOutput
              actionId={upgrade.id}
              onFinished={() =>
                setUpgrade((u) => (u && u.id === upgrade.id ? { ...u, done: true } : u))
              }
            />
          </div>
        )}
        {!s.audit ? (
          <div className="px-4 py-3 text-[13px] text-muted">
            Нет данных: агент ещё не подключался
          </div>
        ) : (
          <Table>
            <TBody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="w-[110px]">{r.chip}</td>
                  <td>
                    {r.text}
                    {r.hint && <div className="mt-0.5 text-xs text-muted">{r.hint}</div>}
                  </td>
                  <td className="w-px text-right">{r.action}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="py-3 text-ok">Замечаний нет</td>
                </tr>
              )}
            </TBody>
          </Table>
        )}
        {s.audit && (
          <BannedIps
            audit={s.audit}
            serverId={s.id}
            disabled={!canAct}
            reason={online ? lock.reason : 'Сервер не в сети'}
          />
        )}
      </Section>
      <BaselineDialog
        serverId={s.id}
        open={baseline !== null}
        preselect={baseline || null}
        onClose={() => setBaseline(null)}
        onKeys={() => {
          setBaseline(null);
          onTab?.('keys');
        }}
      />
    </>
  );
}
