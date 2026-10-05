import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { openfluxDocs } from '../db/schema.js';
import { newId } from './ids.js';

/**
 * Пул документов для каналов OpenFlux клиентов. Нода и приложение открывают
 * документ анонимно, поэтому нужен документ с редактированием по ссылке; создать его можно
 * только из своего аккаунта, программно - никак. Документ - на один канал: общий документ на
 * нескольких каналах теряет ответы.
 */
export type OfDocKind = 'vyandex' | 'mailru';

// как valid_url и valid_mailru в node-install.sh (и provision.CheckTransports OpenFlux)
const KINDS: { kind: OfDocKind; re: RegExp }[] = [
  {
    kind: 'vyandex',
    re: /^https:\/\/(docs|disk)\.yandex\.(ru|com|by|kz|uz)\/edit\/d\/[A-Za-z0-9_-]{16,200}$/,
  },
  {
    kind: 'mailru',
    re: /^https:\/\/cloud\.mail\.ru\/public\/[A-Za-z0-9_-]{2,64}\/[A-Za-z0-9_-]{2,128}$/,
  },
];

/** Ссылка без запроса, якоря и хвостового "/" (как cleanLink у OpenFlux) и её вид; null - не подходит. */
export function ofDocKind(raw: string): { kind: OfDocKind; url: string } | null {
  let url = raw.trim();
  const cut = url.search(/[?#]/);
  if (cut >= 0) url = url.slice(0, cut);
  url = url.replace(/\/+$/, '');
  const k = KINDS.find((x) => x.re.test(url));
  return k ? { kind: k.kind, url } : null;
}

/** Добавить ссылки (по строке на документ): сколько добавлено, какие строки не подошли. */
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
export function takeOfDocs(db: Db, bindingId: string): { vyandex: string; mailru: string } {
  return db.transaction((tx) => {
    const out = { vyandex: '', mailru: '' };
    for (const kind of ['vyandex', 'mailru'] as const) {
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

/** Канал удалён - его документы снова свободны. */
export function releaseOfDocs(db: Db, bindingId: string) {
  db.update(openfluxDocs)
    .set({ bindingId: null })
    .where(eq(openfluxDocs.bindingId, bindingId))
    .run();
}
