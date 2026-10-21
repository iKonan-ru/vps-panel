import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TG_SCRIPT, tgUpstreams } from '../src/lib/mtproxyl-upstreams.js';

/**
 * Заглушка mtproxyl: те же файлы и проверки, что у MTProxyL (upstreams.conf, expert.conf),
 * журнал вызовов - calls.log, перезапуск - restarts.
 */
const FAKE = `#!/bin/bash
set -eu
D="$MT_DIR"; U="$D/upstreams.conf"; E="$D/expert.conf"
echo "$*" >>"$D/calls.log"
[ -f "$U" ] || printf '# head\\ndirect|direct||||10||true|\\n' >"$U"
case "$1 \${2:-}" in
  "upstream add")
    grep -q "^$3|" "$U" && { echo "уже существует" >&2; exit 1; }
    echo "$3|$4|$5|$6|$7|$8|$9|true|\${10:-}" >>"$U" ;;
  "upstream remove")
    [ "$(grep -vc '^#' "$U")" -le 1 ] && { echo "Нельзя удалить последний upstream" >&2; exit 1; }
    grep -q "^$3|" "$U" || { echo "не найден" >&2; exit 1; }
    sed -i "/^$3|/d" "$U" ;;
  "upstream enable") sed -i -E "s/^($3\\|([^|]*\\|){6})[a-z]+/\\1true/" "$U" ;;
  "upstream disable") sed -i -E "s/^($3\\|([^|]*\\|){6})[a-z]+/\\1false/" "$U" ;;
  "upstream test")
    a=$(awk -F'|' -v n="$3" '$1==n {print $3}' "$U")
    if [ "$a" = 127.0.0.1:2001 ]; then echo "Проверка socks5 прокси $a..."; echo "socks5 прокси OK - IP выхода: 203.0.113.20"
    else echo "socks5 прокси $a не отвечает"; fi ;;
  "expert set") touch "$E"; sed -i "/^$3|$4|/d" "$E"; echo "$3|$4|$5" >>"$E" ;;
  "expert clear") [ -f "$E" ] && sed -i "/^$3|$4|/d" "$E" ;;
  "restart ") echo x >>"$D/restarts" ;;
  "status --json") [ -f "$D/stopped" ] && echo '{"status":"stopped"}' || echo '{"status":"running"}' ;;
  *) echo "неизвестно: $*" >&2; exit 2 ;;
esac
`;

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'mtl-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'mtproxyl'), FAKE);
  chmodSync(join(bin, 'mtproxyl'), 0o755);
  const run = (env: Record<string, string>) =>
    execFileSync('bash', ['-c', TG_SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH}`, MT_DIR: dir, ...env },
      encoding: 'utf8',
    });
  const file = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
  const routes = () =>
    file('upstreams.conf')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
  return { dir, run, file, routes, restarts: () => file('restarts').split('\n').length - 1 };
}

const WANT = 'vpc-a:2001:100 vpc-b:2002:1';

describe('маршруты MTProxyL каскада Telegram', () => {
  it('tgUpstreams: основные поровну, запасные - только когда не отвечает ни один основной', () => {
    const row = (id: string, main: boolean, port: number | null, at: string, tg = true) => ({
      id,
      telegram: tg,
      telegramMain: main,
      telegramPort: port,
      createdAt: at,
      error: null as string | null,
    });
    const rows = [
      row('b', true, 2002, '2'),
      row('a', true, 2001, '1'),
      row('c', false, 2003, '3'),
      row('d', false, null, '4', false),
    ];
    const names = (u: { name: string; weight: number }[]) => u.map((x) => [x.name, x.weight]);
    // два основных - поровну, запасного нет в маршрутах
    expect(names(tgUpstreams(rows))).toEqual([
      ['vpc-a', 10],
      ['vpc-b', 10],
    ]);
    // один основной не отвечает - всё через второй
    expect(names(tgUpstreams(rows, new Set(['a'])))).toEqual([['vpc-b', 10]]);
    // не отвечает ни один основной - запасной
    expect(names(tgUpstreams(rows, new Set(['a', 'b'])))).toEqual([['vpc-c', 10]]);
    // каскад с ошибкой - тоже как не отвечающий
    const broken = rows.map((r) => (r.id === 'b' ? { ...r, error: 'нет inbound-а' } : r));
    expect(names(tgUpstreams(broken, new Set(['a'])))).toEqual([['vpc-c', 10]]);
    // основных нет вовсе - все отвечающие запасные поровну
    const spares = rows.map((r) => ({ ...r, telegramMain: false }));
    expect(tgUpstreams(spares)).toHaveLength(3);
    // не отвечает никто - все отмеченные
    expect(tgUpstreams(rows, new Set(['a', 'b', 'c']))).toHaveLength(3);
  });

  it('включение: свои маршруты, direct выключен, ME выключен, один перезапуск', () => {
    const b = box();
    const out = b.run({ WANT, TESTS: 'vpc-a vpc-b' });
    expect(out).toContain('TG:changed');
    expect(out).toContain('TG:test=vpc-a=203.0.113.20');
    expect(out).toContain('TG:test=vpc-b=');
    expect(b.routes()).toEqual(
      expect.arrayContaining([
        'direct|direct||||10||false|',
        'vpc-a|socks5|127.0.0.1:2001|||100||true|',
        'vpc-b|socks5|127.0.0.1:2002|||1||true|',
        'vpc-local|direct||||1||true|local',
      ]),
    );
    expect(b.file('expert.conf')).toContain('general|use_middle_proxy|false');
    expect(b.file('expert.conf')).toContain('censorship|tls_fetch_scope|local');
    expect(b.file('vps-panel-telegram.conf')).toContain('DISABLED=direct');
    expect(b.restarts()).toBe(1);
    // сначала свои маршруты, потом выключение direct, перезапуск - последним
    const calls = b.file('calls.log').split('\n').filter(Boolean);
    const at = (p: string) => calls.findIndex((c) => c.startsWith(p));
    expect(at('upstream add vpc-a')).toBeLessThan(at('upstream disable direct'));
    expect(calls.filter((c) => !c.startsWith('upstream test')).at(-1)).toBe('restart');
    // второй раз - менять нечего
    expect(b.run({ WANT, CHECK: '1' })).toContain('TG:same');
    expect(b.run({ WANT })).not.toContain('TG:changed');
    expect(b.restarts()).toBe(1);
  });

  it('смена основного: веса переписываются', () => {
    const b = box();
    b.run({ WANT });
    expect(b.run({ WANT: 'vpc-a:2001:1 vpc-b:2002:100', CHECK: '1' })).toContain('TG:diff');
    b.run({ WANT: 'vpc-a:2001:1 vpc-b:2002:100' });
    expect(b.routes()).toContain('vpc-b|socks5|127.0.0.1:2002|||100||true|');
    expect(b.routes()).toContain('vpc-a|socks5|127.0.0.1:2001|||1||true|');
  });

  it('выключение: всё как было до панели', () => {
    const b = box();
    b.run({ WANT });
    expect(b.run({ WANT: '', CHECK: '1' })).toContain('TG:diff');
    b.run({ WANT: '' });
    expect(b.routes()).toEqual(['direct|direct||||10||true|']);
    expect(b.file('expert.conf').trim()).toBe('');
    expect(existsSync(join(b.dir, 'vps-panel-telegram.conf'))).toBe(false);
    expect(b.run({ WANT: '', CHECK: '1' })).toContain('TG:same');
  });

  it('ME, выключенный владельцем до панели, после выключения остаётся выключенным', () => {
    const b = box();
    writeFileSync(join(b.dir, 'expert.conf'), 'general|use_middle_proxy|false\n');
    b.run({ WANT });
    b.run({ WANT: '' });
    expect(b.file('expert.conf')).toContain('general|use_middle_proxy|false');
  });

  it('включённый WARP или донор - отказ без изменений', () => {
    const b = box();
    writeFileSync(
      join(b.dir, 'upstreams.conf'),
      'direct|direct||||10||false|\nwarp|socks5|127.0.0.1:40000|||1||true|\n',
    );
    expect(() => b.run({ WANT })).toThrow();
    expect(b.restarts()).toBe(0);
    expect(b.routes()).toHaveLength(2);
  });

  it('файла состояния нет, свои маршруты единственные - direct включается обратно', () => {
    const b = box();
    b.run({ WANT });
    execFileSync('rm', [join(b.dir, 'vps-panel-telegram.conf')]);
    b.run({ WANT: '' });
    expect(b.routes()).toEqual(['direct|direct||||10||true|']);
  });

  it('Reanimator - отказ', () => {
    const b = box();
    writeFileSync(join(b.dir, 'settings.conf'), "MTPROXYL_MODE='reanimator'\n");
    expect(() => b.run({ WANT })).toThrow();
  });

  it('старый формат (7 колонок): включённый direct выключается, как у MTProxyL', () => {
    const b = box();
    writeFileSync(join(b.dir, 'upstreams.conf'), 'direct|direct||||10|true\n');
    b.run({ WANT });
    // заглушка старый формат не пересохраняет (MTProxyL пишет файл заново) - важна сама команда
    expect(b.file('calls.log')).toContain('upstream disable direct');
  });

  it('суперэксперт - отказ без изменений', () => {
    const b = box();
    writeFileSync(join(b.dir, 'settings.conf'), "SUPEREXPERT_ENABLED='true'\n");
    writeFileSync(join(b.dir, 'superexpert.toml'), '');
    expect(() => b.run({ WANT })).toThrow();
    expect(b.file('calls.log')).toBe('');
  });

  it('снятие отметок при включённом WARP: direct и ME не трогаются, свои маршруты уходят', () => {
    const b = box();
    b.run({ WANT });
    // WARP включили поверх: свои выключил, сам - socks без области
    writeFileSync(
      join(b.dir, 'upstreams.conf'),
      `${b
        .routes()
        .map((l) =>
          l.startsWith('vpc-a') || l.startsWith('vpc-b') ? l.replace('|true|', '|false|') : l,
        )
        .join('\n')}\nwarp|socks5|127.0.0.1:40000|||1||true|\n`,
    );
    b.run({ WANT: '' });
    expect(b.routes()).toEqual([
      'direct|direct||||10||false|',
      'warp|socks5|127.0.0.1:40000|||1||true|',
    ]);
    expect(b.file('expert.conf')).toContain('general|use_middle_proxy|false');
    expect(existsSync(join(b.dir, 'vps-panel-telegram.conf'))).toBe(false);
  });

  it('остановленный прокси не запускается: маршруты записаны, перезапуска нет', () => {
    const b = box();
    writeFileSync(join(b.dir, 'stopped'), '');
    const out = b.run({ WANT });
    expect(out).toContain('TG:changed');
    expect(b.restarts()).toBe(0);
    expect(b.routes()).toContain('vpc-a|socks5|127.0.0.1:2001|||100||true|');
  });
});
