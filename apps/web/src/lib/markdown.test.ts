import { describe, expect, it } from 'vitest';
import { inline, parseMarkdown } from './markdown';

describe('markdown: строки', () => {
  it('код, жирный, курсив, зачёркнутый, вложенность', () => {
    expect(inline('a `b` **c** _d_ ~~e~~')).toEqual([
      'a ',
      { t: 'code', text: 'b' },
      ' ',
      { t: 'b', c: ['c'] },
      ' ',
      { t: 'i', c: ['d'] },
      ' ',
      { t: 's', c: ['e'] },
    ]);
    expect(inline('**жирный `код` и *курсив***')).toEqual([
      { t: 'b', c: ['жирный ', { t: 'code', text: 'код' }, ' и ', { t: 'i', c: ['курсив'] }] },
    ]);
    expect(inline('``a ` b``')).toEqual([{ t: 'code', text: 'a ` b' }]);
  });
  it('звёздочки и подчёркивания в словах и без пары - текст', () => {
    expect(inline('snake_case_name и 5 * 3 * 2')).toEqual(['snake_case_name и 5 * 3 * 2']);
    expect(inline('`a_b` <сервер>')).toEqual([{ t: 'code', text: 'a_b' }, ' <сервер>']);
  });
  it('ссылки, автоссылки, экранирование и перенос строки', () => {
    expect(inline('[текст](https://e.com/a_(b) "t") и https://e.com/x.')).toEqual([
      { t: 'a', href: 'https://e.com/a_(b)', c: ['текст'] },
      ' и ',
      { t: 'a', href: 'https://e.com/x', c: ['https://e.com/x'] },
      '.',
    ]);
    expect(inline('<https://e.com>')).toEqual([
      { t: 'a', href: 'https://e.com', c: ['https://e.com'] },
    ]);
    expect(inline('\\*не курсив\\*')).toEqual(['*не курсив*']);
    expect(inline('a  \nb')).toEqual(['a', { t: 'br' }, 'b']);
  });
});

describe('markdown: блоки', () => {
  it('заголовки, абзацы с переносом, линия, цитата', () => {
    const b = parseMarkdown('# Заголовок\n\nстрока\nещё строка\n\n---\n> цитата\n> дальше');
    expect(b[0]).toEqual({ t: 'h', level: 1, c: ['Заголовок'] });
    expect(b[1]).toEqual({ t: 'p', c: ['строка\nещё строка'] });
    expect(b[2]).toEqual({ t: 'hr' });
    expect(b[3]).toMatchObject({ t: 'quote' });
  });
  it('списки: вложенные, нумерованные, задачи, перенос строки внутри пункта', () => {
    const b = parseMarkdown(
      '- первый\n  продолжение\n  - вложенный\n- [x] готово\n- [ ] нет\n\n1. раз\n2. два',
    );
    const ul = b[0];
    expect(ul).toMatchObject({ t: 'list', ordered: false });
    if (ul?.t !== 'list') throw new Error('нет списка');
    expect(ul.items).toHaveLength(3);
    expect(ul.items[0]?.blocks[0]).toEqual({ t: 'p', c: ['первый\nпродолжение'] });
    expect(ul.items[0]?.blocks[1]).toMatchObject({ t: 'list' });
    expect([ul.items[1]?.task, ul.items[2]?.task]).toEqual([true, false]);
    expect(b[1]).toMatchObject({ t: 'list', ordered: true, start: 1 });
  });
  it('блок кода сохраняет текст как есть, внутри разметка не разбирается', () => {
    const b = parseMarkdown('```sh\nls **-la**\n\n  tail\n```\nпосле');
    expect(b[0]).toEqual({ t: 'code', lang: 'sh', text: 'ls **-la**\n\n  tail' });
    expect(b[1]).toEqual({ t: 'p', c: ['после'] });
  });
  it('таблица с выравниванием', () => {
    const b = parseMarkdown('| a | b |\n|:--|--:|\n| 1 | `2` |');
    expect(b[0]).toMatchObject({
      t: 'table',
      align: ['left', 'right'],
      head: [['a'], ['b']],
      rows: [[['1'], [{ t: 'code', text: '2' }]]],
    });
  });
  it('раздел CHANGELOG: пункты с переносом строк и кодом', () => {
    const b = parseMarkdown(
      '- Строка с `кодом`\n  и продолжением.\n- Второй пункт: `vps-panel restore <файл>`',
    );
    expect(b).toHaveLength(1);
    if (b[0]?.t !== 'list') throw new Error('нет списка');
    expect(b[0].items).toHaveLength(2);
  });
});
