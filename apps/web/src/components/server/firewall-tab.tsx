import { ActionPanel } from '@/components/action-output';
import { PortsyncDialog, RuleDialog } from '@/components/server/firewall-dialogs';
import { MetricCard } from '@/components/server/metric-card';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { InfoTip } from '@/components/ui/info-tip';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { TBody, THead, Table } from '@/components/ui/table';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FirewallRule } from '@vps/protocol';
import { Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';

const originTitle: Record<FirewallRule['origin'], string> = {
  permanent: 'постоянное',
  portsync: 'port-sync',
  docker: 'контейнер (DOCKER-USER)',
  'deny-list': 'deny-список',
  manual: 'вручную',
};

/** Вкладка Firewall: состояние, правила, настройки port-sync, "слушает наружу". */
export function FirewallTab({ s }: { s: ServerDetail }) {
  const qc = useQueryClient();
  const fw = s.inventory?.firewall ?? null;
  const online = s.status === 'online';
  // пока на сервере идёт другое действие, изменения недоступны
  const lock = serverLock(s);
  const canAct = online && !lock.busy;
  const op = useAction();
  const [actionId, setActionId] = useState<{ id: string; title: string } | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ручные правила панели: на сервере они помечены только "panel:<id>", комментарий - в базе
  const manual = useQuery({
    queryKey: ['fw-rules', s.id],
    queryFn: () => api<{ id: string; comment: string }[]>(`/api/servers/${s.id}/firewall/rules`),
  });

  async function run(fn: () => Promise<unknown>) {
    await op.run(async () => {
      await fn();
      await qc.invalidateQueries({ queryKey: ['servers'] });
      await qc.invalidateQueries({ queryKey: ['fw-rules', s.id] });
    });
  }

  async function enable() {
    await run(async () => {
      const r = await actions.firewallEnable(s.id);
      setActionId({ id: r.actionId, title: 'Включение firewall' });
    });
  }
  async function disable(restartDocker: boolean) {
    setDisableOpen(false);
    await run(async () => {
      const r = await actions.firewallDisable(s.id, restartDocker);
      setActionId({ id: r.actionId, title: 'Выключение firewall' });
    });
  }

  if (!fw) {
    return <Card className="p-8 text-[13px] text-muted">Нет данных: агент ещё не подключался</Card>;
  }

  const manualComment = new Map((manual.data ?? []).map((r) => [r.id, r.comment]));
  const rules = fw.rules.map((r) =>
    r.manualId && manualComment.get(r.manualId)
      ? { ...r, comment: manualComment.get(r.manualId) ?? '' }
      : r,
  );
  const dockerWithPorts = (s.inventory?.containers ?? []).filter(
    (c) => c.published.length > 0,
  ).length;
  const sourceText = (r: FirewallRule) =>
    r.source === 'any' || r.source === 'Anywhere' ? 'любой' : r.source;
  const actionChip = (r: FirewallRule) =>
    r.action === 'allow' ? <Chip tone="ok">allow</Chip> : <Chip tone="bad">deny</Chip>;
  /** Удаление своего правила; правила port-sync и docker не удаляются руками. */
  const ruleAction = (r: FirewallRule) =>
    r.origin === 'manual' && r.manualId ? (
      <Button
        size="sm"
        variant="ghost"
        aria-label="Удалить правило"
        disabled={!canAct || op.busy}
        title={lock.reason}
        onClick={() => {
          const id = r.manualId;
          if (id) void run(() => actions.ruleDelete(s.id, id));
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    ) : (
      <span className="text-xs text-muted">авто</span>
    );

  return (
    <>
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3 md:gap-4">
        <MetricCard
          label="ufw"
          value={fw.ufwActive ? 'Включён' : 'Выключен'}
          tone={fw.ufwActive ? 'ok' : 'bad'}
          note={
            fw.ufwActive
              ? `входящие: ${fw.defaultIncoming || 'deny'}, исходящие: allow`
              : 'все порты открыты'
          }
          action={
            <Switch
              checked={fw.ufwActive}
              label="Firewall"
              disabled={!canAct || op.busy}
              onChange={() => (fw.ufwActive ? setDisableOpen(true) : void enable())}
            />
          }
        />
        <MetricCard
          label="port-sync"
          value={
            !fw.portsyncInstalled ? 'Не установлен' : fw.portsyncActive ? 'Работает' : 'Остановлен'
          }
          tone={!fw.portsyncInstalled ? 'warn' : fw.portsyncActive ? 'ok' : 'bad'}
          note={
            fw.portsyncLastRun
              ? `последний запуск ${ago(fw.portsyncLastRun)}`
              : 'устанавливается в \u00abОбзоре\u00bb'
          }
          action={
            <Button
              variant="link"
              className="text-xs"
              disabled={!canAct || !fw.portsyncInstalled || op.busy}
              title={lock.reason ?? 'Пересчитать правила по слушающим портам'}
              aria-label="Пересчитать"
              onClick={() => run(() => actions.portsyncRun(s.id))}
            >
              <RefreshCw className="size-3.5 md:size-3" />
              <span className="hidden md:inline">пересчитать</span>
            </Button>
          }
        />
        <MetricCard
          label="Docker"
          value={
            !s.inventory?.host.dockerVersion
              ? 'Нет'
              : fw.dockerFiltered
                ? 'Фильтруется'
                : 'Не фильтруется'
          }
          tone={!s.inventory?.host.dockerVersion ? 'muted' : fw.dockerFiltered ? 'ok' : 'warn'}
          note={
            s.inventory?.host.dockerVersion
              ? `контейнеров с портами: ${dockerWithPorts}`
              : 'docker не установлен'
          }
        />
      </div>

      {actionId && (
        <ActionPanel
          title={actionId.title}
          actionId={actionId.id}
          onHide={() => setActionId(null)}
        />
      )}

      <Section
        title="Правила"
        extra={<Chip>{rules.length}</Chip>}
        actions={
          <ActionBar
            actions={[
              {
                key: 'portsync',
                label: 'Настройки port-sync',
                short: 'port-sync',
                icon: <Settings2 className="size-3.5" />,
                disabled: !canAct,
                title: lock.reason,
                onClick: () => setSettingsOpen(true),
              },
              {
                key: 'add',
                label: 'Добавить правило',
                short: 'Правило',
                icon: <Plus className="size-3.5" />,
                variant: 'primary',
                disabled: !canAct,
                title: lock.reason,
                onClick: () => setRuleOpen(true),
              },
            ]}
          />
        }
      >
        <div className="hidden md:block">
          <Table>
            <THead>
              <tr>
                <th>Порт</th>
                <th>Протокол</th>
                <th>Источник</th>
                <th>Действие</th>
                <th>Происхождение</th>
                <th>Комментарий</th>
                <th />
              </tr>
            </THead>
            <TBody>
              {rules.map((r, i) => (
                <tr key={`${r.port}-${r.proto}-${r.source}-${i}`}>
                  <td className="font-mono">{r.port}</td>
                  <td>{r.proto}</td>
                  <td className="font-mono">{sourceText(r)}</td>
                  <td>{actionChip(r)}</td>
                  <td className="text-muted">{originTitle[r.origin]}</td>
                  <td className="text-muted">{r.comment}</td>
                  <td className="text-right">{ruleAction(r)}</td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-muted">
                    {fw.ufwActive ? 'Правил нет' : 'Firewall выключен'}
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
        </div>
        {/* на мобиле - компактные строки: широкая таблица уходит за край экрана */}
        <div className="divide-y divide-border md:hidden">
          {rules.map((r, i) => (
            <div
              key={`${r.port}-${r.proto}-${r.source}-${i}`}
              className="flex flex-col gap-0.5 px-4 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono">
                  {r.port}/{r.proto}
                </span>
                {actionChip(r)}
                <div className="grow" />
                {ruleAction(r)}
              </div>
              <div className="text-xs text-muted">
                <span className="font-mono">{sourceText(r)}</span>, {originTitle[r.origin]}
                {r.comment && `, ${r.comment}`}
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <div className="px-4 py-4 text-center text-muted">
              {fw.ufwActive ? 'Правил нет' : 'Firewall выключен'}
            </div>
          )}
        </div>
      </Section>

      <Card className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 font-semibold">
            Слушает наружу
            <InfoTip>
              Зачёркнутое закрыто firewall. Открывается правилом или известным процессом в
              настройках port-sync.
            </InfoTip>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {fw.listeners.length === 0 && (
            <span className="text-[13px] text-muted">ничего не слушает</span>
          )}
          {fw.listeners.map((l) => (
            <Chip
              key={`${l.proto}-${l.port}-${l.process}`}
              tone={l.open ? 'accent' : 'muted'}
              className={cn('font-mono', !l.open && 'line-through')}
            >
              {l.port}/{l.proto} {l.process}
            </Chip>
          ))}
        </div>
      </Card>

      <Dialog open={disableOpen} onClose={() => setDisableOpen(false)} title="Выключить firewall?">
        <div className="text-sm text-muted">
          Все порты сервера откроются снаружи. Правила DOCKER-USER останутся; сбросить их можно
          перезапуском docker, он обрывает VPN-соединения.
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDisableOpen(false)}>Отмена</Button>
          <Button variant="danger" disabled={!canAct || op.busy} onClick={() => disable(false)}>
            Выключить
          </Button>
          <Button variant="danger" disabled={!canAct || op.busy} onClick={() => disable(true)}>
            Выключить и перезапустить docker
          </Button>
        </div>
      </Dialog>

      {/* окно монтируется при открытии: каждое открытие - с чистой формой, без прошлой ошибки */}
      {ruleOpen && (
        <RuleDialog
          serverId={s.id}
          open={ruleOpen}
          onClose={() => setRuleOpen(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['servers'] })}
        />
      )}
      <PortsyncDialog
        serverId={s.id}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['servers'] })}
      />
    </>
  );
}
