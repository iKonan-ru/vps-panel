import { ActionPanel } from '@/components/action-output';
import { CascadeForm, MODE_TITLE } from '@/components/server/xui-cascade-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { ApiError, api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { CascadeView, CascadesView } from '@vps/protocol';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

/** Каскады сервера (кэш общий с inbound-ами: строки каскадов там помечены). */
export function useCascades(serverId: string, enabled = true) {
  return useQuery({
    queryKey: ['cascades', serverId],
    queryFn: () => api<CascadesView>(`/api/servers/${serverId}/cascades`),
    staleTime: 20_000,
    retry: false,
    enabled,
  });
}

function CheckChip({ c }: { c: CascadeView }) {
  if (c.error)
    return (
      <Chip tone="bad" title={c.error} className="min-w-0 shrink">
        <span className="truncate">{c.error}</span>
      </Chip>
    );
  if (!c.check) return <Chip>не проверен</Chip>;
  return c.check.ok ? (
    <Chip tone="ok" dot>
      {`${c.check.ms}\u00a0мс`}
    </Chip>
  ) : (
    <Chip tone="bad" title={c.check.error ?? ''}>
      выход не отвечает
    </Chip>
  );
}

/**
 * Каскад: клиент подключается к этому серверу, трафик уходит на выход. Блок во вкладке 3X-UI
 * входа; на выходе - строки "через этот сервер выходит каскад".
 */
export function XuiCascades({
  serverId,
  disabled,
  reason,
}: {
  serverId: string;
  disabled: boolean;
  reason: string | undefined;
}) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data, error, isFetching } = useCascades(serverId);
  const op = useAction();
  const [form, setForm] = useState<{ cascade?: CascadeView } | null>(null);
  const [run, setRun] = useState<{ id: string; title: string } | null>(null);
  const noToken = error instanceof ApiError && error.code === 'no-token';
  const list = data?.cascades ?? [];
  const via = data?.via ?? [];
  const locked = disabled || op.busy || isFetching;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['cascades', serverId] });
    void qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
  };

  async function check(c: CascadeView) {
    await op.run(async () => {
      await api(`/api/cascades/${c.id}/check`, { method: 'POST' });
      await refresh();
    });
  }

  const tgList = list.filter((c) => c.telegram);
  const even = data?.telegram.balance === 'even';

  async function setBalance() {
    const ok = await ask({
      title: even ? 'Telegram через основной выход?' : 'Telegram поровну между выходами?',
      text: 'Прокси MTProxyL этого сервера перезапустится, Telegram у клиентов переподключится через несколько секунд.',
      okLabel: even ? 'Через основной' : 'Поровну',
    });
    if (!ok) return;
    await op.run(async () => {
      const r = await api<{ actionId: string }>(`/api/servers/${serverId}/cascades/telegram`, {
        method: 'POST',
        json: { balance: even ? 'main' : 'even' },
      });
      setRun({ id: r.actionId, title: 'Распределение Telegram' });
    });
  }

  async function remove(c: CascadeView) {
    const ok = await ask({
      title: `Удалить каскад через ${c.exitServerName}?`,
      text: `Inbound \u00ab${c.entryRemark}\u00bb (порт ${c.entryPort ?? '?'}) будет удалён, ссылки через него пропадут из подписок.`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      const r = await api<{ actionId: string }>(`/api/cascades/${c.id}/delete`, {
        method: 'POST',
      });
      setRun({ id: r.actionId, title: `Удаление каскада через ${c.exitServerName}` });
    });
  }

  return (
    <>
      {run && <ActionPanel title={run.title} actionId={run.id} onHide={() => setRun(null)} />}
      <Section
        title="Каскад"
        info={
          'Клиент подключается к этому серверу, трафик уходит на выход. Ссылки через этот сервер\u00a0\u2014 в подписках рядом с прямыми; клиенты панели получают каскад, только если им разрешён VLESS на выходе'
        }
        extra={list.length > 0 && <Chip>{list.length}</Chip>}
        actions={
          <Button
            size="sm"
            label="Добавить каскад"
            short="Добавить"
            title={noToken ? 'Нужен API-токен 3X-UI' : reason}
            disabled={locked || !data}
            onClick={() => {
              op.setError(null);
              setForm({});
            }}
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {op.error && !form && (
          <div className="p-4 pb-0">
            <Alert tone="bad">{op.error}</Alert>
          </div>
        )}
        {data?.telegram.error && list.some((c) => c.telegram) && (
          <div className="p-4 pb-0">
            <Alert tone="bad">{`MTProxyL: ${data.telegram.error}`}</Alert>
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-[13px] text-muted">
            {noToken ? 'Нужен API-токен 3X-UI' : `Не удалось получить каскады: ${error.message}`}
          </div>
        )}
        {tgList.length > 1 && (
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-[13px]">
            <div className="min-w-0 grow">
              <div>Telegram поровну между выходами</div>
              <div className="text-xs text-muted">
                {even
                  ? 'соединения делятся между отвечающими выходами'
                  : 'почти всё через основной, остальные\u00a0\u2014 запасные'}
              </div>
            </div>
            <Switch
              checked={even}
              disabled={locked}
              label="Telegram поровну между выходами"
              onChange={() => void setBalance()}
            />
          </div>
        )}
        {data && list.length === 0 && via.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Каскадов нет</div>
        )}
        {list.map((c) => (
          // строка выхода не переносится: длинное имя обрезается, плашка проверки - всегда рядом
          <div
            key={c.id}
            className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 grow">
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                <Link
                  to="/servers/$id/$tab"
                  params={{ id: c.exitServerId, tab: 'xui' }}
                  className="min-w-0 truncate font-medium hover:underline"
                >
                  {`\u2192 ${c.exitServerName || 'выход удалён'}`}
                </Link>
                <span className="shrink-0 font-mono text-xs text-muted">{c.entryPort ?? ''}</span>
                <CheckChip c={c} />
              </div>
              <div className="text-xs text-muted">
                {[
                  MODE_TITLE[c.mode].toLowerCase(),
                  c.exitList.length ? `через выход: ${c.exitList.length}` : '',
                  c.directList.length ? `напрямую: ${c.directList.length}` : '',
                  c.blockQuic ? 'QUIC заблокирован' : '',
                  c.telegram
                    ? even
                      ? 'Telegram'
                      : c.telegramMain
                        ? 'Telegram: основной'
                        : 'Telegram: запасной'
                    : '',
                  c.telegram && !even && !c.telegramMain && c.telegramActive && !c.telegramDown
                    ? 'сейчас Telegram через него'
                    : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
                {/* выход не отвечает (Telegram ушёл на другие) или путь не прошёл проверку */}
                {c.telegramDown ? (
                  <span className="text-bad">{', выход не отвечает'}</span>
                ) : (
                  c.telegram &&
                  c.telegramCheck &&
                  !c.telegramCheck.ok && (
                    <span className="text-bad" title={c.telegramCheck.error ?? ''}>
                      {', не проходит'}
                    </span>
                  )
                )}
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              title={reason ?? 'Проверить выход'}
              aria-label="Проверить выход"
              disabled={locked}
              onClick={() => void check(c)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={reason ?? 'Изменить каскад'}
              aria-label="Изменить каскад"
              disabled={locked}
              onClick={() => {
                op.setError(null);
                setForm({ cascade: c });
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={reason ?? 'Удалить каскад'}
              aria-label="Удалить каскад"
              disabled={locked}
              onClick={() => void remove(c)}
            >
              <Trash2 className="size-3.5 text-bad" />
            </Button>
          </div>
        ))}
        {via.length > 0 && (
          <div className="border-t border-border px-4 py-2.5 text-xs text-muted">
            Через этот сервер выходят каскады:{' '}
            {via.map((v, i) => (
              <span key={v.id}>
                {i > 0 && ', '}
                <Link
                  to="/servers/$id/$tab"
                  params={{ id: v.entryServerId, tab: 'xui' }}
                  className="text-accent hover:underline"
                >
                  {v.entryServerName}
                </Link>
              </span>
            ))}
          </div>
        )}
        <Dialog
          open={form !== null}
          onClose={() => setForm(null)}
          title={form?.cascade ? `Каскад через ${form.cascade.exitServerName}` : 'Добавить каскад'}
        >
          {form && (
            <CascadeForm
              serverId={serverId}
              {...(form.cascade ? { cascade: form.cascade } : {})}
              telegram={data?.telegram}
              telegramOthers={list.filter((x) => x.telegram && x.id !== form.cascade?.id).length}
              disabled={locked}
              onCancel={() => setForm(null)}
              onStarted={(id) => {
                const title = form.cascade
                  ? `Каскад через ${form.cascade.exitServerName}`
                  : 'Новый каскад';
                setForm(null);
                setRun({ id, title });
              }}
            />
          )}
        </Dialog>
      </Section>
    </>
  );
}
