import { Chip } from '@/components/ui/chip';
import { InfoTip } from '@/components/ui/info-tip';
import { ago } from '@/lib/format';
import type { GBrowserExt } from '@vps/protocol';

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

/**
 * Подключение расширения клиента через этот сервер (окно плашки "Браузер" сервера в карточке
 * клиента): установки, у которых выбран этот сервер или "Авто" идёт сейчас через него. Старые
 * версии сервер не сообщают - о них только подсказка обновиться.
 */
export function BrowserExtList({ exts, serverId }: { exts: GBrowserExt[]; serverId: string }) {
  const here = exts.filter((e) => e.version !== null && e.viaServerId === serverId);
  const legacy = exts.filter((e) => e.version === null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-sm font-medium">
        Расширение через этот сервер
        <InfoTip>
          Расширение сообщает о себе при каждом изменении и раз в 15 минут, пока браузер открыт:
          версия, включён ли прокси, выбранный сервер, ошибка в окне. При "Авто" браузер идёт через
          первый доступный сервер цепочки - он и считается.
        </InfoTip>
      </div>
      <div className="rounded-lg border border-border">
        {here.length === 0 && (
          <div className="px-3 py-2.5 text-[13px] text-muted">
            Расширение клиента через этот сервер не подключено.
          </div>
        )}
        {here.map((e) => {
          const s = state(e);
          return (
            <div
              key={e.id}
              className="flex flex-col gap-1 border-b border-border px-3 py-2.5 text-[13px] last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{browserName[e.browser]}</span>
                <span className="text-xs text-muted">{e.version}</span>
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
                {`${e.server === 'Авто' ? 'Авто: сейчас через этот сервер' : 'выбран этот сервер'}; отчёт ${ago(e.seenAt)}`}
              </div>
              {e.error && <div className="break-words text-xs text-bad">{e.error}</div>}
            </div>
          );
        })}
      </div>
      {legacy.length > 0 && (
        <div className="text-xs text-muted">
          Старая версия расширения ({legacy.map((e) => browserName[e.browser]).join(', ')}) не
          сообщает, через какой сервер идёт: будет видно после обновления.
        </div>
      )}
    </div>
  );
}
