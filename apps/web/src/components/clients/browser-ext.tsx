import { Chip } from '@/components/ui/chip';
import { Section } from '@/components/ui/section';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import type { GBrowserExt } from '@vps/protocol';
import { Globe } from 'lucide-react';

const browserName: Record<GBrowserExt['browser'], string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  other: 'Браузер',
};

/** Состояние установки одной плашкой: включено, выключено, нет связи. */
function state(e: GBrowserExt): { tone: 'ok' | 'muted' | 'warn'; text: string } {
  if (e.version === null) return { tone: 'muted', text: 'статус неизвестен' };
  if (!e.online) return { tone: 'warn', text: 'нет связи' };
  return e.enabled ? { tone: 'ok', text: 'включено' } : { tone: 'muted', text: 'выключено' };
}

/** Строка подсказки: "Chrome 1.5.0: включено, сервер Авто". */
function summary(e: GBrowserExt): string {
  const s = state(e);
  const server = e.enabled && e.online && e.server ? `, сервер ${e.server}` : '';
  return `${browserName[e.browser]} ${e.version ?? '(старая версия)'}: ${s.text}${server}${e.error ? ` - ${e.error}` : ''}`;
}

/**
 * Значок в карточке списка клиентов: зелёный - прокси включён хотя бы в одном браузере и
 * расширение на связи, жёлтый - включён, но расширение пишет об ошибке, серый - установлено, но
 * выключено или молчит. Что именно - в подсказке.
 */
export function BrowserExtIcon({ exts, className }: { exts: GBrowserExt[]; className?: string }) {
  if (!exts.length) return null;
  const live = exts.filter((e) => e.online && e.enabled);
  const on = live.some((e) => !e.error);
  const tone = on ? 'text-ok' : live.length ? 'text-warn' : 'text-muted';
  const title = `Расширение для браузера\n${exts.map(summary).join('\n')}`;
  return (
    <Globe
      className={cn('size-3.5 shrink-0', tone, className)}
      role="img"
      aria-label={on ? 'Прокси для браузера работает' : 'Прокси для браузера не работает'}
    >
      <title>{title}</title>
    </Globe>
  );
}

/**
 * Блок карточки клиента: установки расширения (браузер, версия, включено ли, сервер, когда было
 * на связи, ошибка в окне). Нет установок и нет прокси для браузера у клиента - блока нет.
 */
export function BrowserExtSection({ exts, hasNaive }: { exts: GBrowserExt[]; hasNaive: boolean }) {
  if (!exts.length && !hasNaive) return null;
  const online = exts.filter((e) => e.online && e.enabled && !e.error).length;
  return (
    <Section
      title="Расширение для браузера"
      info="Расширение сообщает о себе при каждом изменении и раз в 15 минут, пока браузер открыт: версия, включён ли прокси, выбранный сервер, ошибка в окне. Старые версии не сообщают - видно только, когда они брали подписку."
      extra={online > 0 && <Chip tone="ok">работает {online}</Chip>}
    >
      {exts.length === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">
          Не установлено или ещё не выходило на связь.
        </div>
      )}
      {exts.map((e) => {
        const s = state(e);
        return (
          <div
            key={e.id}
            className="flex flex-col gap-1 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{browserName[e.browser]}</span>
              <span className="text-xs text-muted">{e.version ?? 'старая версия'}</span>
              <Chip tone={s.tone} dot={s.tone === 'ok'}>
                {s.text}
              </Chip>
              {e.outdated && (
                <Chip
                  tone="warn"
                  title={
                    e.browser === 'firefox'
                      ? 'Firefox обновит расширение сам'
                      : 'Обновление - кнопкой в окне расширения: скачать и распаковать поверх папки'
                  }
                >
                  устарело
                </Chip>
              )}
            </div>
            <div className="text-xs text-muted">
              {e.version === null
                ? `брало подписку ${ago(e.seenAt)}; статус будет после обновления расширения`
                : `${e.server ? `сервер: ${e.server}; ` : ''}отчёт ${ago(e.seenAt)}`}
            </div>
            {e.error && <div className="break-words text-xs text-bad">{e.error}</div>}
          </div>
        );
      })}
    </Section>
  );
}
