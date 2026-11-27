import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { openfluxDocs } from '../db/schema.js';
import { newId } from './ids.js';

/**
 * Пул ресурсов для каналов OpenFlux клиентов: документы Яндекса и Mail.ru, конференции Телемоста,
 * Яндекс Доски. Нода и приложение открывают их анонимно (документ - с редактированием по ссылке,
 * доска - открытая гостям); создать их можно только из своего аккаунта, программно - никак.
 * Ресурс - на один канал: общий на нескольких каналах теряет ответы.
 */
export const OF_DOC_KINDS = ['vyandex', 'mailru', 'telemost', 'boards'] as const;
type OfDocKind = (typeof OF_DOC_KINDS)[number];
export type OfDocs = Record<OfDocKind, string>;

// как valid_url, valid_mailru, valid_telemost и valid_boards в node-install.sh
const KINDS: { kind: OfDocKind; re: RegExp }[] = [
  {
    kind: 'vyandex',
    re: /^https:\/\/(docs|disk)\.yandex\.(ru|com|by|kz|uz)\/edit\/d\/[A-Za-z0-9_-]{16,200}$/,
  },
  {
    kind: 'mailru',
    re: /^https:\/\/cloud\.mail\.ru\/public\/[A-Za-z0-9_-]{2,64}\/[A-Za-z0-9_-]{2,128}$/,
  },
  { kind: 'telemost', re: /^https:\/\/telemost\.yandex\.ru\/j\/[0-9]{6,32}$/ },
  { kind: 'boards', re: /^https:\/\/boards\.yandex\.ru\/whiteboard\/\?hash=[0-9a-f]{32}$/ },
];

/**
 * Ссылка без запроса, якоря и хвостового "/" (как cleanLink у OpenFlux) и её вид; у доски запрос
 * остаётся - в нём hash доски (лишние параметры отбрасываются). null - не подходит.
 */
export function ofDocKind(raw: string): { kind: OfDocKind; url: string } | null {
  const text = raw.trim().replace(/#.*$/, '');
  const board =
    /^(https:\/\/boards\.yandex\.ru\/whiteboard\/?)\?(?:.*&)?hash=([0-9a-f]{32})(?:&|$)/.exec(text);
  let url = board ? `https://boards.yandex.ru/whiteboard/?hash=${board[2]}` : text;
  if (!board) {
    const cut = url.search(/[?#]/);
    if (cut >= 0) url = url.slice(0, cut);
    url = url.replace(/\/+$/, '');
  }
  const k = KINDS.find((x) => x.re.test(url));
  return k ? { kind: k.kind, url } : null;
}

/** Добавить ссылки (по строке на ресурс): сколько добавлено, какие строки не подошли. */
export function addOfDocs(db: Db, text: string) {
  const bad: string[] = [];
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const d = ofDocKind(line);
    if (!d) {
      bad.push(line.trim().slice(0, 120));
      continue;
    }
    const res = db
      .insert(openfluxDocs)
      .values({ id: newId(), kind: d.kind, url: d.url })
      .onConflictDoNothing()
      .run();
    added += res.changes;
  }
  return { added, bad };
}

/**
 * Документы привязки: уже выданные, а недостающего вида - первый свободный из пула (проверка и
 * выдача - синхронно, без await между ними: два прохода не выдадут один документ двоим).
 */
export function takeOfDocs(db: Db, bindingId: string): OfDocs {
  return db.transaction((tx) => {
    const out: OfDocs = { vyandex: '', mailru: '', telemost: '', boards: '' };
    for (const kind of OF_DOC_KINDS) {
      let doc = tx
        .select()
        .from(openfluxDocs)
        .where(and(eq(openfluxDocs.bindingId, bindingId), eq(openfluxDocs.kind, kind)))
        .get();
      if (!doc) {
        doc = tx
          .select()
          .from(openfluxDocs)
          .where(and(isNull(openfluxDocs.bindingId), eq(openfluxDocs.kind, kind)))
          .orderBy(openfluxDocs.createdAt)
          .get();
        if (doc)
          tx.update(openfluxDocs).set({ bindingId }).where(eq(openfluxDocs.id, doc.id)).run();
      }
      if (doc) out[kind] = doc.url;
    }
    return out;
  });
}

/** Канал удалён - его ресурсы снова свободны. */
export function releaseOfDocs(db: Db, bindingId: string) {
  db.update(openfluxDocs)
    .set({ bindingId: null })
    .where(eq(openfluxDocs.bindingId, bindingId))
    .run();
}
