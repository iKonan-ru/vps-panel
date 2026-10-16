// Проверка типографики русских текстов интерфейса (apps/web/src): в строках, атрибутах и
// JSX-тексте с кириллицей нет прямых двойных кавычек, " - " вместо тире, "..." вместо многоточия
// и "->".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'apps/web/src';
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(n)) files.push(p);
  }
};
walk(root);
const cyr = /[Ѐ-ӿ]/;
const bad = [
  [/ - /, '" - " вместо тире (\\u00a0\\u2014 или &nbsp;&mdash;)'],
  [/\.\.\./, '"..." вместо многоточия (\\u2026 или &hellip;)'],
  [/->/, '"->" вместо стрелки или слов'],
];
let n = 0;
for (const f of files) {
  // комментарии - не тексты интерфейса
  const src = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  const lines = src.split('\n');
  const pieces = [];
  // строковые литералы
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const t = m[1] ?? m[2] ?? '';
    pieces.push({ t, at: m.index, quotes: m[1] !== undefined || m[2] !== undefined });
  }
  // атрибуты JSX в двойных кавычках: title="...", hint="..."
  for (const m of src.matchAll(/[A-Za-z]="([^"\n]*[Ѐ-ӿ][^"\n]*)"/g)) {
    pieces.push({ t: m[1], at: m.index + 2, attr: true });
  }
  // JSX-текст: между > и < на одной или нескольких строках
  for (const m of src.matchAll(/>([^<>{}]*[Ѐ-ӿ][^<>{}]*)</g)) {
    pieces.push({ t: m[1], at: m.index + 1, jsx: true });
  }
  for (const p of pieces) {
    if (!cyr.test(p.t)) continue;
    const line = src.slice(0, p.at).split('\n').length;
    const probs = bad.filter(([re]) => re.test(p.t)).map(([, why]) => why);
    if (p.jsx && /"/.test(p.t)) probs.push('прямые кавычки (&laquo; &raquo;)');
    if (!p.jsx && /"[Ѐ-ӿA-Za-z]/.test(p.t)) probs.push('прямые кавычки (\\u00ab \\u00bb)');
    for (const why of probs) {
      n++;
      console.log(`${f}:${line}: ${why}: ${p.t.trim().slice(0, 90)}`);
    }
  }
}
if (n) {
  console.log(`типографика интерфейса: замечаний ${n}`);
  process.exit(1);
}
