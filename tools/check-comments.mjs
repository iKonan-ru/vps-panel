#!/usr/bin/env node
// Комментарии в своих файлах: без дат (история - не в коде) и без двух JSDoc подряд (первый
// описывает не то, над чем стоит). Использование: node tools/check-comments.mjs <файлы...>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const ts = require('typescript');

// примеры формата вывода дат
const DATES_OK = new Set(['apps/web/src/lib/format.ts', 'apps/server/src/lib/notify.ts']);
const DATE = /(?<![\d.v-])(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])(\.20\d\d)?(?![\d.])/;

const problems = [];
const say = (file, line, text) => problems.push(`${file}:${line}: ${text}`);

/** Комментарии файла: текст, строка начала и конца, JSDoc ли. */
function comments(file, src) {
  const out = [];
  if (/\.(ts|tsx|mjs|js)$/.test(file)) {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
    const seen = new Set();
    const add = (ranges) => {
      for (const r of ranges ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        const text = src.slice(r.pos, r.end);
        out.push({
          text,
          from: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
          to: sf.getLineAndCharacterOfPosition(r.end).line + 1,
          doc: text.startsWith('/**'),
        });
      }
    };
    const walk = (node) => {
      add(ts.getLeadingCommentRanges(src, node.getFullStart()));
      add(ts.getTrailingCommentRanges(src, node.getEnd()));
      for (const ch of node.getChildren(sf)) walk(ch);
    };
    walk(sf);
    add(ts.getLeadingCommentRanges(src, sf.endOfFileToken.getFullStart()));
    out.sort((a, b) => a.from - b.from);
    return out;
  }
  const hash = /\.(sh|py)$/.test(file) || !file.includes('.');
  src.split('\n').forEach((l, i) => {
    const m = hash ? /^\s*#(?!!)(.*)$/.exec(l) : /^\s*\/\/(.*)$/.exec(l);
    if (m) out.push({ text: m[1], from: i + 1, to: i + 1, doc: false });
  });
  return out;
}

for (const file of process.argv.slice(2)) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const list = comments(file, src);
  for (const c of list) {
    if (!DATES_OK.has(file) && DATE.test(c.text))
      say(file, c.from, `дата в комментарии: ${DATE.exec(c.text)?.[0]}`);
  }
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a.doc && b.doc && b.from === a.to + 1)
      say(file, b.from, 'два JSDoc подряд: первый не относится к коду под ним');
  }
}

if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
