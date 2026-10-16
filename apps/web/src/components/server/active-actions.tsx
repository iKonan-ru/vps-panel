import { ActionOutput } from '@/components/action-output';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Section } from '@/components/ui/section';
import { actionTitles } from '@/lib/actions';
import { ago } from '@/lib/format';
import type { ServerDetail } from '@vps/protocol';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Действия, которые панель запускает сама, а не вкладка этой страницы: синхронизация клиентов,
 * адрес в ссылках MTProxyL после смены адреса для клиентов, команды каталога. Их вывод - здесь,
 * даже если они начались после открытия страницы.
 */
const SHOWN_ALWAYS = (kind: string) =>
  kind === 'gclients.sync' || kind === 'mtproxyl:host' || kind.startsWith('command:');

/**
 * Действия на сервере, которые не показывает своя вкладка: шедшие ещё до открытия этой страницы
 * (перезагрузка, другая вкладка) и запущенные панелью (SHOWN_ALWAYS). То, что запущено
 * с этой страницы, показывает свой блок сама вкладка - дублировать не нужно.
 */
export function ActiveActions({ s }: { s: ServerDetail }) {
  const openedAt = useRef(Date.now());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // финиш узнаём сами: после него сервер уже не отдаёт действие в activeActions
  const [finished, setFinished] = useState<Map<string, number>>(new Map());
  const [seen, setSeen] = useState<Map<string, { kind: string; startedAt: string }>>(new Map());

  const active = s.activeActions;
  useEffect(() => {
    const before = active.filter(
      (a) =>
        a.kind !== 'status.refresh' &&
        (SHOWN_ALWAYS(a.kind) || new Date(a.startedAt).getTime() < openedAt.current - 1000),
    );
    if (before.some((a) => !seen.has(a.id))) {
      setSeen((m) => {
        const next = new Map(m);
        for (const a of before) next.set(a.id, { kind: a.kind, startedAt: a.startedAt });
        return next;
      });
    }
  }, [active, seen]);
  const list = [...seen.entries()].filter(([id]) => !closed.has(id));
  if (list.length === 0) return null;

  return (
    <>
      {list.map(([id, a]) => {
        const code = finished.get(id);
        const title = actionTitles[a.kind] ?? a.kind.replace('command:', 'Команда ');
        return (
          <Section
            key={id}
            title={title}
            extra={
              code === undefined ? (
                <Chip tone="accent" dot pulse>
                  выполняется, начато {ago(a.startedAt)}
                </Chip>
              ) : code === 0 ? (
                <Chip tone="ok">завершено</Chip>
              ) : (
                <Chip tone="bad">ошибка</Chip>
              )
            }
            actions={
              <Button
                size="sm"
                onClick={() => setClosed((c) => new Set(c).add(id))}
                title={code === undefined ? 'Действие продолжится' : undefined}
                label={code === undefined ? 'Скрыть' : 'Закрыть'}
              >
                <X className="size-3.5" />
              </Button>
            }
          >
            <div className="p-4">
              <ActionOutput
                actionId={id}
                onFinished={(c) => setFinished((m) => new Map(m).set(id, c))}
              />
            </div>
          </Section>
        );
      })}
    </>
  );
}
