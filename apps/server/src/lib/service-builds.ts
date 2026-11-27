import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROLOGUE } from '../commands/util.js';

/**
 * Сборки, которые панель раздаёт серверам сама (files/<вид>/): wdtt-server и Caddy прокси для
 * браузера. Установка кладёт рядом с бинарником метку - копию files/<вид>/VERSION; метка на
 * сервере не та, что на панели, - сборка устарела. Сравниваются метки, а не sha256: каждый
 * релиз собирает бинарники заново, и байты меняются без смены версий.
 */
export type BuildKind = 'wdtt' | 'naive';

export const BUILD_KINDS: readonly BuildKind[] = ['wdtt', 'naive'];

/** Метка сборки на сервере: копия VERSION, которую пишут установка и обновление. */
export const BUILD_MARK: Record<BuildKind, string> = {
  wdtt: '/etc/wdtt/vps-panel-build',
  naive: '/opt/vps-naive/vps-panel-build',
};

/**
 * Подпись сборки из VERSION: wdtt - "1.4.5+7345d56" как есть; naive - "caddy v2.11.9" и
 * "forwardproxy v0.0.0-...-e747854e7874" -> "2.11.9+e747854". Пусто - не разобрать.
 */
export function buildLabel(kind: BuildKind, raw: string): string {
  const t = raw.trim();
  if (kind === 'naive') {
    const caddy = /caddy v?(\S+)/.exec(t)?.[1];
    const fwd = /forwardproxy \S*-([0-9a-f]{12})\b/.exec(t)?.[1];
    return caddy ? `${caddy}${fwd ? `+${fwd.slice(0, 7)}` : ''}` : '';
  }
  return t.split('\n')[0]?.trim() ?? '';
}

/** Сборка на панели (files/<вид>/VERSION); нет файла - панель этот вид не раздаёт. */
export function panelBuild(filesDir: string, kind: BuildKind): string {
  try {
    return buildLabel(kind, readFileSync(join(filesDir, kind, 'VERSION'), 'utf8'));
  } catch {
    return '';
  }
}

/** Метки обеих сборок одной строкой на вид: "B:<вид>:<VERSION, переводы строк - |>". */
export const BUILD_CHECK_SCRIPT = `${(Object.entries(BUILD_MARK) as [BuildKind, string][])
  .map(
    ([k, f]) =>
      `if [ -f ${f} ]; then printf 'B:${k}:%s\\n' "$(tr '\\n' '|' < ${f})"; else echo 'B:${k}:'; fi`,
  )
  .join('\n')}
`;

/** Разбор вывода BUILD_CHECK_SCRIPT: вид -> подпись сборки на сервере ("" - метки нет). */
export function parseBuildCheck(output: string): Partial<Record<BuildKind, string>> {
  const out: Partial<Record<BuildKind, string>> = {};
  for (const line of output.split('\n')) {
    const m = /^B:(wdtt|naive):(.*)$/.exec(line.trim());
    if (m)
      out[m[1] as BuildKind] = buildLabel(m[1] as BuildKind, (m[2] ?? '').replace(/\|/g, '\n'));
  }
  return out;
}

/** Что обновлять: служба, бинарник, имя файла на панели (без архитектуры), сколько ждать старта. */
const TARGET: Record<BuildKind, { title: string; unit: string; bin: string; file: string }> = {
  wdtt: { title: 'WDTT', unit: 'wdtt', bin: '/usr/local/bin/wdtt-server', file: 'wdtt-server' },
  naive: {
    title: 'Прокси для браузера',
    unit: 'vps-naive',
    bin: '/opt/vps-naive/caddy',
    file: 'caddy',
  },
};

/**
 * Замена бинарника сборкой с панели (PANEL_URL): sha256 сверяется, служба перезапускается, не
 * поднялась за 10 с - прежний бинарник обратно. Настройки и база не трогаются.
 */
export function buildUpdateScript(kind: BuildKind): string {
  const t = TARGET[kind];
  return `${PROLOGUE}
case "$(uname -m)" in
  x86_64) arch=amd64;;
  aarch64|arm64) arch=arm64;;
  *) echo "архитектура $(uname -m) не поддерживается" >&2; exit 2;;
esac
[ -x ${t.bin} ] && systemctl cat ${t.unit} >/dev/null 2>&1 || { echo "${t.title}: не установлен" >&2; exit 3; }
new=$(mktemp); mark=$(mktemp)
trap 'rm -f "$new" "$mark"' EXIT
say "Скачиваю ${t.file}-linux-$arch с панели"
fetch "$PANEL_URL/files/${kind}/${t.file}-linux-$arch" -o "$new"
sum=$(fetch "$PANEL_URL/files/sha256/${kind}/${t.file}-linux-$arch" | sed 's/.*"sha256":"\\([0-9a-f]*\\)".*/\\1/')
echo "$sum  $new" | sha256sum -c - >/dev/null || { echo "контрольная сумма не совпала" >&2; exit 1; }
fetch "$PANEL_URL/files/${kind}/VERSION" -o "$mark"
cp -p ${t.bin} ${t.bin}.prev
install -m 755 "$new" ${t.bin}
say "Перезапуск ${t.unit}: подключения прервутся на несколько секунд"
systemctl restart ${t.unit} || true
ok=0
for _ in 1 2 3 4 5; do sleep 2; systemctl is-active --quiet ${t.unit} && ok=1 && break; done
if [ $ok = 0 ]; then
  echo "${t.unit} не запустился с новой сборкой - возвращаю прежнюю" >&2
  journalctl -u ${t.unit} -n 15 --no-pager 2>/dev/null || true
  install -m 755 ${t.bin}.prev ${t.bin}
  systemctl restart ${t.unit} || true
  rm -f ${t.bin}.prev
  exit 1
fi
install -m 644 "$mark" ${BUILD_MARK[kind]}
rm -f ${t.bin}.prev
say "Готово: ${t.title} $(head -n 1 ${BUILD_MARK[kind]})"
`;
}
