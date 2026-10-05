import { ActionOutput } from '@/components/action-output';
import { SshKeysDialog } from '@/components/server/ssh-keys-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { type BaselinePlan, actions } from '@/lib/actions';
import { Check, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * "Исправить проблемы": агент собирает план (что не так и что изменится), пользователь
 * отмечает, какие шаги применить, затем применение с живым выводом.
 * preselect - шаг, с которого пришли (замечание в блоке "Безопасность"): отмечен только он.
 */
export function BaselineDialog({
  serverId,
  open,
  preselect,
  onClose,
}: { serverId: string; open: boolean; preselect?: string | null; onClose: () => void }) {
  const [plan, setPlan] = useState<BaselinePlan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  const loadPlan = useCallback(() => {
    setPlan(null);
    setError(null);
    actions
      .baselinePlan(serverId)
      .then((p) => {
        setPlan(p);
        // по умолчанию: все нужные и не заблокированные шаги, либо только тот, с которого пришли
        const wanted = p.steps.filter((s) => s.needed && !s.blocker).map((s) => s.id);
        setChosen(new Set(preselect && wanted.includes(preselect) ? [preselect] : wanted));
      })
      .catch((e: Error) => setError(e.message));
  }, [serverId, preselect]);

  useEffect(() => {
    if (!open) return;
    setActionId(null);
    loadPlan();
  }, [open, loadPlan]);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await actions.baselineApply(serverId, [...chosen]);
      setActionId(r.actionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needed = plan?.steps.filter((s) => s.needed) ?? [];
  const done = plan?.steps.filter((s) => !s.needed) ?? [];
  // ufw без port-sync закроет порты VPN: агент добавит port-sync сам, показываем это заранее
  const impliedPortsync =
    chosen.has('ufw') && !chosen.has('portsync') && needed.some((s) => s.id === 'portsync');

  return (
    <Dialog open={open} onClose={onClose} title="Исправить проблемы" wide>
      {error && <Alert tone="bad">{error}</Alert>}
      {actionId ? (
        <>
          <ActionOutput actionId={actionId} />
          <div className="flex justify-end">
            <Button onClick={onClose}>Закрыть</Button>
          </div>
        </>
      ) : !plan ? (
        <div className="text-sm text-muted">Агент проверяет сервер...</div>
      ) : (
        <>
          <div className="text-[13px] text-muted">
            Отметь, что исправить. Работающие контейнеры и VPN не трогаются.
          </div>
          {needed.length === 0 ? (
            <div className="text-sm text-ok">Проблем нет, исправлять нечего.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {needed.map((s) => (
                <Checkbox
                  key={s.id}
                  disabled={Boolean(s.blocker)}
                  checked={chosen.has(s.id) || (s.id === 'portsync' && impliedPortsync)}
                  onChange={() => toggle(s.id)}
                  label={s.title}
                  hint={
                    <>
                      {s.detail && <span className="block">{s.detail}</span>}
                      {s.blocker && (
                        <span className="mt-1 block text-bad">
                          {s.blocker}
                          {s.id === 'sshd' && plan.rootKeys === 0 && (
                            <Button
                              size="sm"
                              className="ml-2"
                              onClick={() => setKeysOpen(true)}
                              label="Добавить ключ root"
                            >
                              <KeyRound className="size-3.5" />
                            </Button>
                          )}
                        </span>
                      )}
                      {s.id === 'portsync' && impliedPortsync && (
                        <span className="block">
                          нужен для firewall: без него ufw закроет порты VPN
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          )}
          {done.length > 0 && (
            <div className="flex flex-col gap-1">
              {done.map((s) => (
                <div key={s.id} className="flex items-start gap-2.5 text-xs text-muted">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                  {s.title}
                </div>
              ))}
            </div>
          )}
          {plan.ports.length > 0 && (chosen.has('ufw') || chosen.has('portsync')) && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Порты после включения firewall</div>
              <div className="flex flex-wrap gap-1.5">
                {plan.ports.map((p) => (
                  <Chip
                    key={`${p.port}/${p.proto}`}
                    tone={p.action === 'open' ? 'ok' : 'bad'}
                    className="font-mono"
                  >
                    {p.action === 'open' ? 'открыт' : 'ЗАКРОЕТСЯ'} {p.port}/{p.proto} {p.process}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <div className="text-xs text-muted">
            SSH-порт {plan.sshPort}, ключей у root: {plan.rootKeys}
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" disabled={chosen.size === 0 || busy} onClick={apply}>
              Исправить ({chosen.size + (impliedPortsync ? 1 : 0)})
            </Button>
          </div>
        </>
      )}
      {/* окно монтируется при открытии: каждое открытие - с чистой формой, без прошлой ошибки */}
      {keysOpen && (
        <SshKeysDialog
          serverId={serverId}
          open={keysOpen}
          onClose={() => {
            setKeysOpen(false);
            loadPlan();
          }}
        />
      )}
    </Dialog>
  );
}
