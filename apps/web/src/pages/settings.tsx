import { OpenfluxDocsSettings } from '@/components/openflux-docs-settings';
import { PanelBackupSettings } from '@/components/panel-backup-settings';
import { MetricCard } from '@/components/server/metric-card';
import { TelegramSettings } from '@/components/telegram-settings';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { InfoTip } from '@/components/ui/info-tip';
import { Num } from '@/components/ui/num';
import { PageTitle } from '@/components/ui/page-title';
import { Pager, usePaged } from '@/components/ui/pager';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import { WdttSettings } from '@/components/wdtt-settings';
import { XraySettings } from '@/components/xray-settings';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';

interface Security {
  failed24: number;
  failed7d: number;
  topIps: { ip: string; n: number; last: string }[];
  recent: { ip: string; login: string; ok: boolean; at: string }[];
  sessions: { id: string; ip: string; userAgent: string; createdAt: string; expiresAt: string }[];
}

/** Настройки: уведомления, бэкап панели, выход в Telegram, WDTT и безопасность самой панели. */
export function SettingsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ask = useConfirm();
  const logoutAll = useAction();
  const sec = useQuery({
    queryKey: ['security'],
    queryFn: () => api<Security>('/api/security'),
    refetchInterval: 60_000,
  });
  const { data: servers } = useServers();
  const panelHost = typeof location !== 'undefined' ? location.hostname : '';
  // Сервер, на котором стоит панель: его jail vps-panel показывает баны fail2ban.
  const panelServer = servers?.find((s) => s.panelHost);
  const panelJail = panelServer?.audit?.jails.find((j) => j.name === 'vps-panel');
  const d = sec.data;
  const recent = usePaged(d?.recent ?? []);

  return (
    <>
      <PageTitle>Настройки</PageTitle>

      <TelegramSettings />

      <PanelBackupSettings />

      <XraySettings />

      <WdttSettings />
      <OpenfluxDocsSettings />

      <div className="grid gap-3 sm:grid-cols-3 md:gap-4">
        <MetricCard
          label={
            <span className="flex items-center gap-1">
              Неудачных входов за сутки
              <InfoTip>
                Защита входа: пароль и код 2FA, 5 неудачных попыток - пауза 15 минут, fail2ban на
                сервере панели банит IP на час после 5 неудач за 15 минут. Баны fail2ban приходят в
                Telegram, если в уведомлениях включены баны.
              </InfoTip>
            </span>
          }
          value={d ? <Num value={d.failed24} /> : '-'}
          tone={(d?.failed24 ?? 0) > 20 ? 'warn' : undefined}
          note={`за 7 дней: ${d?.failed7d ?? '-'}`}
        />
        <MetricCard
          label="fail2ban: jail vps-panel"
          value={panelJail ? <Num value={panelJail.banned} /> : '-'}
          unit="забанено сейчас"
          tone={(panelJail?.banned ?? 0) > 0 ? 'warn' : undefined}
          note={
            panelJail
              ? `всего банов ${panelJail.totalBanned}, в окне ${panelJail.failed} неудачных`
              : `нет данных: агент на ${panelHost} должен быть обновлён и jail vps-panel включён`
          }
        />
        <MetricCard
          label={
            <span className="flex items-center gap-1">
              Активных сессий
              <InfoTip>Выход на всех устройствах закрывает и эту сессию.</InfoTip>
            </span>
          }
          value={d ? <Num value={d.sessions.length} /> : '-'}
          note="вместе с этой"
          action={
            <Button
              variant="link"
              className="text-xs"
              disabled={logoutAll.busy}
              title="Выйти на всех устройствах"
              aria-label="Выйти на всех устройствах"
              onClick={async () => {
                const ok = await ask({
                  title: 'Выйти на всех устройствах?',
                  text: 'Все сессии панели закроются, войти заново - с кодом 2FA.',
                  okLabel: 'Выйти везде',
                  danger: true,
                });
                if (!ok) return;
                const done = await logoutAll.run(() =>
                  api('/api/auth/logout-all', { method: 'POST' }),
                );
                if (!done) return;
                qc.setQueryData(['me'], null);
                await navigate({ to: '/login' });
              }}
            >
              <LogOut className="size-3.5 md:size-3" />
              <span className="hidden md:inline">выйти везде</span>
            </Button>
          }
        >
          {logoutAll.error && <Alert tone="bad">{logoutAll.error}</Alert>}
        </MetricCard>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section
          title="Откуда ломятся"
          extra={<span className="text-xs text-muted">неудачные попытки за 7 дней</span>}
        >
          <Table>
            <THead>
              <tr>
                <th>IP</th>
                <th>Попыток</th>
                <th>Последняя</th>
              </tr>
            </THead>
            <TBody>
              {(d?.topIps ?? []).map((r) => (
                <tr key={r.ip}>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.n}</td>
                  <td className="text-muted">{ago(r.last)}</td>
                </tr>
              ))}
              {d && d.topIps.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-muted">
                    Неудачных попыток не было
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
        </Section>
        <Section title="Последние попытки входа">
          <Table>
            <THead>
              <tr>
                <th>Когда</th>
                <th>IP</th>
                <th>Логин</th>
                <th>Итог</th>
              </tr>
            </THead>
            <TBody>
              {recent.items.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="whitespace-nowrap text-muted">{ago(r.at)}</td>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.login}</td>
                  <td>{r.ok ? <Chip tone="ok">вход</Chip> : <Chip tone="bad">отказ</Chip>}</td>
                </tr>
              ))}
              {d && d.recent.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted">
                    Пока пусто
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
          <Pager {...recent} />
        </Section>
      </div>

      <Section title="Активные сессии">
        <Table>
          <THead>
            <tr>
              <th>Открыта</th>
              <th>IP</th>
              <th>Браузер</th>
              <th>Истекает</th>
            </tr>
          </THead>
          <TBody>
            {(d?.sessions ?? []).map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap text-muted">{ago(s.createdAt)}</td>
                <td className="font-mono">{s.ip}</td>
                <td className="max-w-[420px] truncate text-muted" title={s.userAgent}>
                  {s.userAgent}
                </td>
                <td className="whitespace-nowrap text-muted">
                  {new Date(s.expiresAt).toLocaleDateString('ru-RU')}
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
      </Section>
    </>
  );
}
