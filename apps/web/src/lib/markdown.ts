/**
 * Markdown как на GitHub (GFM) без HTML: заголовки, абзацы, списки (вложенные, нумерованные, задачи),
 * цитаты, блоки кода, таблицы, линии, а внутри строк - код, жирный, курсив, зачёркнутый, ссылки и
 * автоссылки. Разбор отдаёт дерево, а не строку HTML: разметка из чужого текста не выполняется.
 */

export type Inline =
  | string
  | { t: 'code'; text: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** null - не задача; иначе - отмечена ли */
  task: boolean | null;
  blocks: Block[];
}

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const blank = (l: string) => l.trim() === '';
const indentOf = (l: string) => l.length - l.trimStart().length;

/** Начало блока, который прерывает абзац. */
function startsBlock(l: string, next: string | undefined): boolean {
  if (FENCE.test(l) || (HEADING.test(l) && /^ {0,3}#/.test(l)) || HR.test(l) || QUOTE.test(l))
    return true;
  const m = ITEM.exec(l);
  // список прерывает абзац, если пункт не пустой, а нумерованный - начинается с 1
  if (m && (m[4] ?? '') !== '' && (/^[-*+]$/.test(m[2] ?? '') || /^1[.)]$/.test(m[2] ?? '')))
    return true;
  return isTableStart(l, next);
}

function isTableStart(l: string, next: string | undefined): boolean {
  return next !== undefined && l.includes('|') && TABLE_SEP.test(next) && next.includes('-');
}

/** Ячейки строки таблицы: разделитель "|", экранированный "\|" остаётся в тексте. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const open = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(l)) {
          i++;
          break;
        }
        body.push(l.slice(Math.min(open, indentOf(l))));
        i++;
      }
      out.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h && /^ {0,3}#/.test(line)) {
      out.push({ t: 'h', level: (h[1] ?? '#').length, c: inline(h[2] ?? '') });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(QUOTE, ''));
        i++;
      }
      out.push({ t: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1] ?? '').map((c): Align => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i] ?? '') && (lines[i] ?? '').includes('|')) {
        const row = cells(lines[i] ?? '');
        rows.push(head.map((_, k) => inline(row[k] ?? '')));
        i++;
      }
      out.push({ t: 'table', head: head.map(inline), align, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const r = parseList(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }
    // абзац: до пустой строки или начала блока
    const para: string[] = [line];
    i++;
    while (i < lines.length && !blank(lines[i] ?? '') && !startsBlock(lines[i] ?? '', lines[i + 1]))
      para.push(lines[i++] ?? '');
    out.push({ t: 'p', c: inline(para.map((l) => l.trim()).join('\n')) });
  }
  return out;
}

function parseList(lines: string[], from: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[from] ?? '');
  const ordered = /\d/.test(first?.[2] ?? '');
  const bullet = first?.[2] ?? '-';
  const delim = ordered ? (first?.[2] ?? '').slice(-1) : bullet;
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i] ?? '');
    if (!m) break;
    const sameKind = ordered
      ? /\d/.test(m[2] ?? '') && (m[2] ?? '').slice(-1) === delim
      : m[2] === bullet;
    if (!sameKind) break;
    const markerWidth = (m[1] ?? '').length + (m[2] ?? '').length;
    const gap = (m[4] ?? '') === '' ? 1 : Math.min((m[3] ?? ' ').length, 4);
    const content = markerWidth + gap;
    const body: string[] = [m[4] ?? ''];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (blank(l)) {
        // пустая строка: пункт продолжается, если дальше строка с отступом пункта
        let j = i;
        while (j < lines.length && blank(lines[j] ?? '')) j++;
        if (j < lines.length && indentOf(lines[j] ?? '') >= content) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= content) {
        body.push(l.slice(content));
        i++;
        continue;
      }
      // ленивое продолжение абзаца пункта: строка без отступа, не начало блока и не пункт
      const prev = body[body.length - 1] ?? '';
      if (!blank(prev) && !ITEM.test(l) && !startsBlock(l, lines[i + 1])) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    let task: boolean | null = null;
    const t = /^\[([ xX])\]\s+/.exec(body[0] ?? '');
    if (t) {
      task = t[1] !== ' ';
      body[0] = (body[0] ?? '').slice(t[0].length);
    }
    items.push({ task, blocks: parseBlocks(body) });
    // следующий пункт того же списка - с отступом меньше содержимого предыдущего
    let j = i;
    while (j < lines.length && blank(lines[j] ?? '')) j++;
    if (
      j < lines.length &&
      j > i &&
      ITEM.test(lines[j] ?? '') &&
      indentOf(lines[j] ?? '') < content
    )
      i = j;
  }
  const start = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1;
  return { block: { t: 'list', ordered, start, items }, next: i };
}

// ---- строки ----

const PUNCT = /[!-/:-@[-`{-~]/;
const URL_RE = /^https?:\/\/[^\s<]+/i;

/** Адрес без хвостовой пунктуации, не входящей в ссылку (как автоссылки GitHub). */
function trimUrl(u: string): string {
  let url = u;
  for (;;) {
    const last = url.at(-1) ?? '';
    if (/[.,:;!?'"*_~]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0))
      url = url.slice(0, -1);
    else return url;
  }
}

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Конец ссылки "[текст](адрес)": индекс после ")" и разобранные части, либо null. */
function linkAt(s: string, i: number): { end: number; text: string; href: string } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  const text = s.slice(i + 1, j);
  let k = j + 2;
  while (s[k] === ' ') k++;
  let href: string;
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0) return null;
    href = s.slice(k + 1, e);
    k = e + 1;
  } else {
    const st = k;
    let p = 0;
    while (k < s.length && !/\s/.test(s[k] ?? '')) {
      if (s[k] === '(') p++;
      else if (s[k] === ')' && p-- === 0) break;
      k++;
    }
    href = s.slice(st, k);
  }
  while (s[k] === ' ') k++;
  if (s[k] === '"' || s[k] === "'") {
    const e = s.indexOf(s[k] ?? '"', k + 1);
    if (e < 0) return null;
    k = e + 1;
    while (s[k] === ' ') k++;
  }
  return s[k] === ')' ? { end: k + 1, text, href } : null;
}

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\\' && src[i + 1] === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 2;
      continue;
    }
    if (c === '\\' && PUNCT.test(src[i + 1] ?? '')) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === ' ' && src[i + 1] === ' ' && /^ +\n/.test(src.slice(i))) {
      flush();
      out.push({ t: 'br' });
      i += src.slice(i).indexOf('\n') + 1;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (src[i + n] === '`') n++;
      // закрывающая серия - ровно той же длины
      const re = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g');
      re.lastIndex = i + n;
      const end = re.exec(src)?.index ?? -1;
      if (end >= 0) {
        flush();
        let text = src.slice(i + n, end).replace(/\n/g, ' ');
        if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '')
          text = text.slice(1, -1);
        out.push({ t: 'code', text });
        i = end + n;
        continue;
      }
      buf += '`'.repeat(n);
      i += n;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const l = linkAt(src, i + 1);
      if (l) {
        flush();
        out.push({ t: 'a', href: l.href, c: [l.text || l.href] });
        i = l.end;
        continue;
      }
    }
    if (c === '[') {
      const l = linkAt(src, i);
      if (l) {
        flush();
        out.push({ t: 'a', href: l.href, c: inline(l.text) });
        i = l.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'a', href: m[1] ?? '', c: [m[1] ?? ''] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && !isWord(src[i - 1])) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > 8) {
          flush();
          out.push({ t: 'a', href: url, c: [url] });
          i += url.length;
          continue;
        }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 1;
      while (src[i + n] === c) n++;
      const kind = c === '~' ? (n === 2 ? 's' : null) : n >= 3 ? 'bi' : n === 2 ? 'b' : 'i';
      const take = kind === 'bi' ? 3 : kind === 's' || kind === 'b' ? 2 : 1;
      const mark = c.repeat(take);
      const prev = src[i - 1];
      const after = src[i + take];
      const opens =
        kind !== null &&
        after !== undefined &&
        !/\s/.test(after) &&
        !(c === '_' && isWord(prev)) &&
        !(c === '~' && n !== 2);
      if (opens) {
        let j = i + take;
        let end = -1;
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '`') {
            const e = src.indexOf('`', j + 1);
            j = e < 0 ? j + 1 : e + 1;
            continue;
          }
          if (
            src.startsWith(mark, j) &&
            src[j + take] !== c &&
            (take > 1 || src[j - 1] !== c) &&
            !/\s/.test(src[j - 1] ?? ' ') &&
            !(c === '_' && isWord(src[j + take]))
          ) {
            end = j;
            break;
          }
          j++;
        }
        if (end > i + take) {
          flush();
          const inner = inline(src.slice(i + take, end));
          out.push(
            kind === 'bi'
              ? { t: 'b', c: [{ t: 'i', c: inner }] }
              : { t: kind as 'b' | 'i' | 's', c: inner },
          );
          i = end + take;
          continue;
        }
      }
      buf += c.repeat(n);
      i += n;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Разбор markdown-текста в блоки. */
export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}
