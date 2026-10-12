import { ActionPanel } from '@/components/action-output';
import { MetricCard } from '@/components/server/metric-card';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TBody, THead, Table } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { type PortsyncConfig, type RuleInput, actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FirewallRule } from '@vps/protocol';
import { Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionId, setActionId] = useState<{ id: string; title: string } | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ручные правила панели: на сервере они помечены только "panel:<id>", комментарий - в базе
  const manual = useQuery({
    queryKey: ['fw-rules', s.id],
    queryFn: () => api<{ id: string; comment: string }[]>(`/api/servers/${s.id}/firewall/rules`),
  });

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['servers'] });
      await qc.invalidateQueries({ queryKey: ['fw-rules', s.id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function enable() {
    await run('enable', async () => {
      const r = await actions.firewallEnable(s.id);
      setActionId({ id: r.actionId, title: 'Включение firewall' });
    });
  }
  async function disable(restartDocker: boolean) {
    setDisableOpen(false);
    await run('disable', async () => {
      const r = await actions.firewallDisable(s.id, restartDocker);
      setActionId({ id: r.actionId, title: 'Выключение firewall' });
    });
  }

  if (!fw) {
    return (
      <Card className="p-8 text-[13px] text-muted">
        Состояние firewall появится после первого подключения агента.
      </Card>
    );
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
        disabled={!canAct || busy !== null}
        title={lock.reason}
        onClick={() => {
          const id = r.manualId;
          if (id) void run('rule', () => actions.ruleDelete(s.id, id));
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    ) : (
      <span className="text-xs text-muted">авто</span>
    );

  return (
    <>
      {error && <Alert tone="bad">{error}</Alert>}
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
              label={fw.ufwActive ? 'Выключить firewall' : 'Включить firewall'}
              disabled={!canAct || busy !== null}
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
              ? `последний прогон ${ago(fw.portsyncLastRun)}`
              : 'ставится кнопкой "Исправить проблемы" в обзоре'
          }
          action={
            <Button
              variant="link"
              className="text-xs"
              disabled={!canAct || !fw.portsyncInstalled || busy !== null}
              title={lock.reason ?? 'Пересчитать правила по слушающим портам'}
              aria-label="Пересчитать"
              onClick={() => run('portsync', () => actions.portsyncRun(s.id))}
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
              ? `цепочка DOCKER-USER, контейнеров с портами: ${dockerWithPorts}`
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
                <th>Откуда взялось</th>
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
                    {fw.ufwActive
                      ? 'Правил нет'
                      : 'Firewall выключен, правил нет. Включи его здесь или через "Исправить проблемы" в обзоре.'}
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
                <span className="font-mono">{sourceText(r)}</span> - {originTitle[r.origin]}
                {r.comment && ` - ${r.comment}`}
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <div className="px-4 py-4 text-center text-muted">
              {fw.ufwActive
                ? 'Правил нет'
                : 'Firewall выключен, правил нет. Включи его здесь или через "Исправить проблемы" в обзоре.'}
            </div>
          )}
        </div>
      </Section>

      <Card className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 font-semibold">
            Слушает наружу
            <InfoTip>
              Зачёркнутое закрыто firewall-ом; чтобы открыть, добавь процесс в известные или порт в
              правила.
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

      <Dialog open={disableOpen} onClose={() => setDisableOpen(false)} title="Выключить firewall">
        <div className="text-sm text-muted">
          После выключения все порты сервера будут открыты снаружи. Docker-правила в цепочке
          DOCKER-USER остаются, чтобы не трогать работающие контейнеры; их можно сбросить
          перезапуском docker (обрывает VPN-соединения).
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDisableOpen(false)}>Отмена</Button>
          <Button
            variant="danger"
            disabled={!canAct || busy !== null}
            onClick={() => disable(false)}
          >
            Выключить
          </Button>
          <Button
            variant="danger"
            disabled={!canAct || busy !== null}
            onClick={() => disable(true)}
          >
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

function RuleDialog({
  serverId,
  open,
  onClose,
  onSaved,
}: { serverId: string; open: boolean; onClose: () => void; onSaved: () => unknown }) {
  const [f, setF] = useState({
    port: '',
    proto: 'tcp' as RuleInput['proto'],
    source: '',
    action: 'allow' as RuleInput['action'],
    comment: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const m = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(f.port.trim());
    if (!m) return setError('Порт: число или диапазон, например 5432 или 56000-56003');
    setBusy(true);
    setError(null);
    try {
      const rule: RuleInput = {
        portFrom: Number(m[1]),
        proto: f.proto,
        source: f.source.trim() || 'any',
        action: f.action,
        comment: f.comment.trim(),
      };
      if (m[2]) rule.portTo = Number(m[2]);
      await actions.ruleAdd(serverId, rule);
      await onSaved();
      setF({ port: '', proto: 'tcp', source: '', action: 'allow', comment: '' });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Добавить правило">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Порт или диапазон" htmlFor="r-port">
            <Input
              id="r-port"
              value={f.port}
              onChange={(e) => setF({ ...f, port: e.target.value })}
              placeholder="5432 или 56000-56003"
              required
            />
          </Field>
          <Field label="Протокол" htmlFor="r-proto">
            <Select
              id="r-proto"
              value={f.proto}
              onChange={(e) => setF({ ...f, proto: e.target.value as RuleInput['proto'] })}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="any">tcp и udp</option>
            </Select>
          </Field>
          <Field label="Источник" htmlFor="r-src">
            <Input
              id="r-src"
              value={f.source}
              onChange={(e) => setF({ ...f, source: e.target.value })}
              placeholder="любой, IP или сеть 10.0.0.0/8"
            />
          </Field>
          <Field label="Действие" htmlFor="r-act">
            <Select
              id="r-act"
              value={f.action}
              onChange={(e) => setF({ ...f, action: e.target.value as RuleInput['action'] })}
            >
              <option value="allow">allow - разрешить</option>
              <option value="deny">deny - запретить</option>
            </Select>
          </Field>
        </div>
        <Field label="Комментарий" htmlFor="r-comment">
          <Input
            id="r-comment"
            value={f.comment}
            onChange={(e) => setF({ ...f, comment: e.target.value })}
            placeholder="зачем нужно"
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Добавить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const lines = (v: string[]) => v.join('\n');
const parseLines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function PortsyncDialog({
  serverId,
  open,
  onClose,
  onSaved,
}: { serverId: string; open: boolean; onClose: () => void; onSaved: () => unknown }) {
  const [cfg, setCfg] = useState<PortsyncConfig | null>(null);
  const [f, setF] = useState({ admin: '', deny: '', extra: '', known: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCfg(null);
    setError(null);
    actions
      .portsyncGet(serverId)
      .then((c) => {
        setCfg(c);
        setF({
          admin: lines(c.admin_ips),
          deny: lines(c.deny_public_ports),
          extra: lines(c.extra_allow),
          known: lines(c.known_processes),
        });
      })
      .catch((e: Error) => setError(e.message));
  }, [open, serverId]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    setBusy(true);
    setError(null);
    try {
      await actions.portsyncPut(serverId, {
        ...cfg,
        admin_ips: parseLines(f.admin),
        deny_public_ports: parseLines(f.deny),
        extra_allow: parseLines(f.extra),
        known_processes: parseLines(f.known),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Настройки port-sync" wide>
      {!cfg && !error && <div className="text-sm text-muted">Загрузка...</div>}
      {error && <Alert tone="bad">{error}</Alert>}
      {cfg && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center gap-1 text-[13px] text-muted">
            По одному значению в строке.
            <InfoTip>
              port-sync сам открывает порты SSH, 3X-UI, MTProxyL, WireGuard и опубликованные порты
              контейнеров. Здесь - то, что он не может узнать сам.
            </InfoTip>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Известные процессы (открываются, если слушают порт)" htmlFor="p-known">
              <Textarea
                id="p-known"
                value={f.known}
                onChange={(e) => setF({ ...f, known: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Запретить снаружи (порты, даже если процесс известен)" htmlFor="p-deny">
              <Textarea
                id="p-deny"
                value={f.deny}
                onChange={(e) => setF({ ...f, deny: e.target.value })}
                placeholder="9090/tcp"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Всегда открыть (порт/протокол)" htmlFor="p-extra">
              <Textarea
                id="p-extra"
                value={f.extra}
                onChange={(e) => setF({ ...f, extra: e.target.value })}
                placeholder="8443/tcp"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="IP администратора (для служебных портов, можно пусто)" htmlFor="p-admin">
              <Textarea
                id="p-admin"
                value={f.admin}
                onChange={(e) => setF({ ...f, admin: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Порты контейнеров" htmlFor="p-docker">
              <Select
                id="p-docker"
                value={cfg.docker_policy}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    docker_policy: e.target.value as PortsyncConfig['docker_policy'],
                  })
                }
              >
                <option value="published">открывать опубликованные (-p) автоматически</option>
                <option value="explicit">только из списка "всегда открыть"</option>
              </Select>
            </Field>
            <Field label="Ping" htmlFor="p-ping">
              <Select
                id="p-ping"
                value={cfg.allow_ping ? '1' : '0'}
                onChange={(e) => setCfg({ ...cfg, allow_ping: e.target.value === '1' })}
              >
                <option value="1">разрешить</option>
                <option value="0">запретить</option>
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Сохранить и применить
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
