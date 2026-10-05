import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import type { ServerDetail } from '@/lib/servers';
import type { Cert } from '@vps/protocol';
import { ShieldCheck } from 'lucide-react';

const sourceTitle: Record<Cert['source'], string> = {
  'acme.sh': 'acme.sh (3X-UI)',
  certbot: 'certbot',
  xui: 'указан в 3X-UI',
  mtproxyl: 'панель MTProxyL',
  caddy: 'Caddy',
  naive: 'Caddy прокси для браузера',
  other: 'другое',
};

const consumerTitle = (c: string) =>
  c === 'xui'
    ? '3X-UI'
    : c === 'naive'
      ? 'прокси для браузера'
      : c === 'mtproxyl'
        ? 'панель MTProxyL'
        : c.startsWith('systemd:')
          ? `служба ${c.slice(8)}`
          : c.startsWith('docker:')
            ? `контейнер ${c.slice(7)}`
            : c;

function daysTone(d: number, autoRenew: boolean): 'ok' | 'warn' | 'bad' {
  if (d < 0) return 'bad';
  if (d <= 7 && !autoRenew) return 'bad';
  if (d <= 14 && !autoRenew) return 'warn';
  return 'ok';
}

/**
 * Вкладка "Сертификаты" - только просмотр: что есть на сервере и когда истекает. HTTPS панелей
 * сервисов даёт Caddy панели (поддомены), VPN сертификатов не требует; прокси для браузера
 * (naive) - исключение: сертификат выпускает его Caddy сам.
 */
export function CertsTab({ s }: { s: ServerDetail }) {
  const certs = s.inventory?.certs ?? [];
  const expiry = (c: Cert) => (
    <Chip tone={daysTone(c.daysLeft, c.autoRenew)}>
      {c.daysLeft < 0 ? `истёк ${-c.daysLeft} дн назад` : `через ${c.daysLeft} дн`}
    </Chip>
  );
  const renewal = (c: Cert) =>
    c.autoRenew ? (c.source === 'caddy' || c.source === 'naive' ? 'Caddy, сам' : 'есть') : 'нет';

  if (!s.inventory)
    return (
      <Card className="p-8 text-[13px] text-muted">
        Данные появятся после первого подключения агента.
      </Card>
    );

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted" />
          Сертификаты
        </span>
      }
      info="Только просмотр. Панели сервисов открываются через поддомены VPS Panel с её сертификатом (Caddy), сами панели на серверах слушают 127.0.0.1 - сертификаты на серверах не нужны. VPN (Reality, FakeTLS, AWG, WDTT) их тоже не требует. Исключение - прокси для браузера (naive): его Caddy сам выпускает и продлевает сертификат имени сервера."
      extra={<Chip>{certs.length}</Chip>}
    >
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <th>Домены / IP</th>
              <th>Откуда</th>
              <th>Истекает</th>
              <th>Продление</th>
              <th>Кем используется</th>
            </tr>
          </THead>
          <TBody>
            {certs.map((c) => (
              <tr key={c.path}>
                <td>
                  <div className="font-mono">{c.subjects.join(', ') || c.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted" title={c.path}>
                    {c.issuer || 'самоподписанный'} - {c.path}
                  </div>
                </td>
                <td className="whitespace-nowrap">
                  <Chip tone="muted">{sourceTitle[c.source]}</Chip>
                </td>
                <td className="whitespace-nowrap">{expiry(c)}</td>
                <td className="whitespace-nowrap text-muted">{renewal(c)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {c.usedBy.length === 0 && <span className="text-xs text-muted">-</span>}
                    {c.usedBy.map((u) => (
                      <Chip key={u}>{consumerTitle(u)}</Chip>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {certs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted">
                  Сертификатов на сервере нет - и не нужно.
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>
      {/* на мобиле - карточки: широкая таблица уходит за край экрана */}
      <div className="divide-y divide-border md:hidden">
        {certs.map((c) => (
          <div key={c.path} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 grow break-all font-mono">
                {c.subjects.join(', ') || c.name}
              </div>
              {expiry(c)}
            </div>
            <div className="truncate text-xs text-muted" title={c.path}>
              {c.issuer || 'самоподписанный'} - {c.path}
            </div>
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
              <Chip tone="muted">{sourceTitle[c.source]}</Chip>
              {c.usedBy.map((u) => (
                <Chip key={u}>{consumerTitle(u)}</Chip>
              ))}
              <span className="ml-1">продление: {renewal(c)}</span>
            </div>
          </div>
        ))}
        {certs.length === 0 && (
          <div className="px-4 py-4 text-center text-muted">
            Сертификатов на сервере нет - и не нужно.
          </div>
        )}
      </div>
    </Section>
  );
}
