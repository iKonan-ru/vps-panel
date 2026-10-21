import type { AgentRegistry } from '../agents/registry.js';
import { newId } from './ids.js';

/** Upstream-ы MTProxyL, которые ведёт панель (каскад Telegram): только с этим началом имени. */
export const TG_UPSTREAM_PREFIX = 'vpc-';
export const tgUpstreamName = (cascadeId: string) => `${TG_UPSTREAM_PREFIX}${cascadeId}`;

/** Вес маршрута: у всех, кто сейчас в маршрутах, один - telemt делит соединения поровну. */
export const TG_WEIGHT = 10;

export interface TgUpstream {
  name: string;
  port: number;
  weight: number;
}

export interface TgRow {
  id: string;
  telegram: boolean;
  telegramMain: boolean;
  telegramPort: number | null;
  createdAt: string;
  /** Каскад не собран (его socks ведёт в блок). */
  error: string | null;
}

/**
 * Маршруты MTProxyL входа по каскадам с отметкой Telegram (порт - socks-inbound Xray входа).
 * Основных выходов сколько угодно: Telegram делится поровну между отвечающими основными, запасные
 * трафика не получают и входят в маршруты, только когда не отвечает ни один основной. Отвечает -
 * каскад собран и не в down (проверка панели не прошла). Решает панель, а не telemt: socks Xray
 * отвечает "соединение есть" до того, как дошёл до выхода, и проверка маршрутов telemt мёртвый
 * выход не видит. Не отвечает никто - все отмеченные: лучше нет.
 */
export function tgUpstreams(
  rows: readonly TgRow[],
  down: ReadonlySet<string> = new Set(),
): TgUpstream[] {
  const all = rows
    .filter((r) => r.telegram && r.telegramPort)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const live = all.filter((r) => !r.error && !down.has(r.id));
  const mains = live.filter((r) => r.telegramMain);
  const use = mains.length ? mains : live.length ? live : all;
  return use.map((r) => ({
    name: tgUpstreamName(r.id),
    port: Number(r.telegramPort),
    weight: TG_WEIGHT,
  }));
}

/**
 * Приводит маршруты MTProxyL к списку WANT ("имя:порт:вес" через пробел) командами самого
 * MTProxyL (их проверки и формат файлов - его). Есть маршруты:
 * - свои vpc-* - socks5 127.0.0.1:<порт> с весом, vpc-local - напрямую с областью local, через
 *   него MTProxyL берёт TLS-метаданные маски (локальная заглушка через выход недоступна);
 * - чужие включённые маршруты без области (direct) выключаются, иначе часть соединений пойдёт к
 *   Telegram с адреса входа; включённый чужой socks или shadowsocks (WARP, донор) - отказ;
 * - middle proxy выключается: его ключи зависят от адреса выхода, а socks Xray его не отдаёт.
 * Что выключила панель, помнит файл vps-panel-telegram.conf: пустой WANT возвращает это назад
 * и убирает свои маршруты. Перезапуск движка - один раз в конце и только при изменениях.
 * CHECK=1 - только ответ, есть ли что менять. TESTS - "имя:порт" маршрутов для проверки (адрес
 * выхода); маршрута нет в MTProxyL (запасной) - проверка напрямую через socks-inbound Xray.
 * Вывод для панели - строки TG:... и ERR:...
 */
export const TG_SCRIPT = `set -eu
D="\${MT_DIR:-/opt/mtproxyl}"
U="$D/upstreams.conf"; E="$D/expert.conf"; S="$D/vps-panel-telegram.conf"
command -v mtproxyl >/dev/null 2>&1 || { echo "ERR:на сервере нет MTProxyL"; exit 3; }
if grep -q "^MTPROXYL_MODE='reanimator'" "$D/settings.conf" 2>/dev/null; then
  echo "ERR:MTProxyL в режиме Reanimator: маршруты движка доступны только в режиме Manager"; exit 3
fi
# суперэксперт: конфиг движка - свой файл владельца, маршруты MTProxyL в него не попадают
if grep -q "^SUPEREXPERT_ENABLED='true'" "$D/settings.conf" 2>/dev/null && [ -f "$D/superexpert.toml" ]; then
  echo "ERR:MTProxyL в режиме суперэксперта: маршруты движка задаёт его файл, а не MTProxyL"; exit 3
fi
export MTPROXYL_ASSUME_YES=1 MTPROXYL_NONINTERACTIVE=true UPSTREAM_DEFER_RESTART=true
cur() {
  if [ -f "$U" ]; then grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$U" || true
  else echo 'direct|direct||||10||true|'; fi
}
xv() { [ -f "$E" ] && awk -F'|' -v s="$1" -v k="$2" '$1==s && $2==k {print $3; exit}' "$E" || true; }
sv() { [ -f "$S" ] && awk -F= -v k="$1" '$1==k {print substr($0, length(k) + 2); exit}' "$S" || true; }
in_list() { case ",$2," in *",$1,"*) return 0 ;; esac; return 1; }
declare -A want=()
for w in \${WANT:-}; do
  n=\${w%%:*}; r=\${w#*:}
  want[$n]="socks5|127.0.0.1:\${r%%:*}|\${r#*:}|"
done
on=0; [ \${#want[@]} -gt 0 ] && { on=1; want[vpc-local]="direct||1|local"; }
# порядок: снять несовпавшие свои, добавить свои, выключить чужие (при выключении - включить
# прежние, потом снять свои): последний маршрут MTProxyL не удаляет, движок без маршрута не встанет
pre=(); cmds=(); post=()
add() { cmds+=("$*"); }
disabled="$(sv DISABLED)"; me="$(sv ME)"; tls="$(sv TLS)"
declare -A seen=() state=()
others_on=0; foreign_on=0
# разбор - как load_upstreams MTProxyL: старый формат из 7 колонок (вкл. на месте интерфейса),
# включён всё, что не false, неизвестный тип - direct, не-direct без адреса и плохие имена - нет
while IFS='|' read -r n t a u p w i en sc; do
  [[ "$n" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
  if [ "$i" = true ] || [ "$i" = false ]; then en=$i; i=""; fi
  case "$t" in direct|socks5|socks4|shadowsocks) ;; *) t=direct ;; esac
  [ "$t" != direct ] && [ -z "$a" ] && continue
  [ "$en" = false ] || en=true
  state[$n]=$en
  case "$n" in
    vpc-*)
      seen[$n]=1
      if [ -z "\${want[$n]:-}" ]; then post+=("upstream remove $n"); continue; fi
      [ "$t|$a|$w|$sc" = "\${want[$n]}" ] && [ "$en" = true ] && continue
      pre+=("upstream remove $n"); seen[$n]=""
      ;;
    *)
      [ "$en" = true ] && [ -z "$sc" ] || continue
      if [ "$t" != direct ]; then
        [ $on = 0 ] || { echo "ERR:в MTProxyL включён маршрут $n ($t, например WARP или донор): сначала нужно выключить его"; exit 4; }
        foreign_on=1
      fi
      if [ $on = 1 ]; then
        post+=("upstream disable $n"); in_list "$n" "$disabled" || disabled="\${disabled:+$disabled,}$n"
      else others_on=1; fi
      ;;
  esac
done < <(cur)
if [ $on = 1 ]; then
  for n in "\${!want[@]}"; do
    [ -n "\${seen[$n]:-}" ] && continue
    IFS='|' read -r t a w sc <<<"\${want[$n]}"
    add upstream add "$n" "$t" "$a" '' '' "$w" '' "$sc"
  done
  if [ "$(xv general use_middle_proxy)" != false ]; then add expert set general use_middle_proxy false --no-apply; me=1; fi
  if [ -z "$(xv censorship tls_fetch_scope)" ]; then add expert set censorship tls_fetch_scope local --no-apply; tls=1; fi
elif [ $foreign_on = 0 ]; then
  back=""
  IFS=',' read -ra names <<<"$disabled"
  for n in "\${names[@]}"; do
    [ -n "$n" ] || continue
    if [ "\${state[$n]:-}" = false ]; then add upstream enable "$n"; back=1; fi
  done
  # свои маршруты были единственными (файл состояния пропал): движку нужен маршрут без области
  if [ -z "$back" ] && [ $others_on = 0 ] && [ \${#seen[@]} -gt 0 ]; then
    if [ -n "\${state[direct]:-}" ]; then add upstream enable direct
    else add upstream add direct direct '' '' '' 10 '' ''; fi
  fi
  [ "$me" = 1 ] && [ "$(xv general use_middle_proxy)" = false ] && add expert clear general use_middle_proxy --no-apply
  [ "$tls" = 1 ] && [ "$(xv censorship tls_fetch_scope)" = local ] && add expert clear censorship tls_fetch_scope --no-apply
fi
# снятие отметок при включённом WARP или доноре: прямой маршрут и ME - их, панель только
# убирает свои маршруты
cmds=("\${pre[@]}" "\${cmds[@]}" "\${post[@]}")
# проверка пути: маршрут есть в MTProxyL - его проверкой; нет (запасной, пока отвечают основные) -
# тем же путём напрямую: socks Xray входа -> outbound каскада -> выход
run_tests() {
  for t in \${TESTS:-}; do
    n=\${t%%:*}; port=\${t#*:}
    if cur | awk -F'|' -v n="$n" '$1==n && $8!="false" {f=1} END {exit !f}'; then
      out="$(mtproxyl upstream test "$n" </dev/null 2>&1 || true)"
      ip="$(printf '%s\\n' "$out" | grep 'IP выхода' | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' | tail -1 || true)"
    else
      ip="$(curl -s --max-time 15 --socks5-hostname "127.0.0.1:$port" https://api.ipify.org </dev/null 2>/dev/null |
        grep -oE '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' || true)"
    fi
    echo "TG:test=$n=$ip"
  done
}
if [ "\${CHECK:-}" = 1 ]; then
  if [ \${#cmds[@]} -gt 0 ] || { [ $on = 0 ] && [ -f "$S" ]; }; then echo "TG:diff"; else echo "TG:same"; fi
  run_tests
  exit 0
fi
# что выключила панель - до команд: сбой посередине не теряет, что возвращать
if [ $on = 1 ]; then printf 'DISABLED=%s\\nME=%s\\nTLS=%s\\n' "$disabled" "$me" "$tls" >"$S"; fi
for c in "\${cmds[@]}"; do
  read -ra argv <<<"$c"
  # пустые аргументы ('' в add) - позиционные: собираем заново
  case "$c" in "upstream add "*)
    n=\${argv[2]}
    if [ "$n" = direct ]; then argv=(upstream add direct direct '' '' '' 10 '' '')
    else IFS='|' read -r t a w sc <<<"\${want[$n]}"; argv=(upstream add "$n" "$t" "$a" '' '' "$w" '' "$sc"); fi ;;
  esac
  echo "\$ mtproxyl \${argv[*]}"
  mtproxyl "\${argv[@]}" </dev/null
done
[ $on = 1 ] || rm -f "$S"
if [ \${#cmds[@]} -gt 0 ]; then
  # остановленный владельцем прокси не запускать: изменения применятся при его запуске
  if mtproxyl status --json </dev/null 2>/dev/null | grep -q '"status":"running"'; then
    echo "\$ mtproxyl restart"
    mtproxyl restart </dev/null
  else
    echo "Прокси MTProxyL остановлен: маршруты применятся при его запуске"
  fi
  echo "TG:changed"
fi
run_tests
`;

export interface TgResult {
  /** Есть что менять (CHECK) или поменяли. */
  changed: boolean;
  /** Внешний адрес через маршрут ("" - не ответил). */
  tests: Map<string, string>;
  /** Весь вывод скрипта (для журнала). */
  output: string;
}

/**
 * Скрипт маршрутов MTProxyL на сервере (command.run). Отказ (нет MTProxyL, режим Reanimator,
 * включён WARP или донор) - ошибка с текстом из вывода.
 */
export async function runTelegramUpstreams(
  registry: Pick<AgentRegistry, 'request'>,
  serverId: string,
  opts: {
    want: TgUpstream[];
    check?: boolean;
    /** Маршруты для проверки пути: имя и порт socks-inbound-а Xray. */
    tests?: Pick<TgUpstream, 'name' | 'port'>[];
    onLine?: (line: string) => void;
  },
): Promise<TgResult> {
  let output = '';
  let buf = '';
  const emit = (line: string) => {
    if (!line.startsWith('TG:')) opts.onLine?.(line.replace(/^ERR:/, ''));
  };
  const r = await registry.request<{ exitCode: number }>(
    serverId,
    'command.run',
    {
      runId: newId(),
      script: TG_SCRIPT,
      env: {
        WANT: opts.want.map((u) => `${u.name}:${u.port}:${u.weight}`).join(' '),
        CHECK: opts.check ? '1' : '',
        TESTS: (opts.tests ?? []).map((t) => `${t.name}:${t.port}`).join(' '),
      },
      files: {},
      cleanup: [],
      timeoutSec: 240,
    },
    {
      timeoutMs: 300_000,
      onStream: (_ch, chunk) => {
        output += chunk;
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const l of parts) if (l.trim()) emit(l.trim());
      },
    },
  );
  if (buf.trim()) emit(buf.trim());
  const lines = output.split('\n').map((l) => l.trim());
  if (r.exitCode !== 0) {
    const err = lines.find((l) => l.startsWith('ERR:'))?.slice(4);
    const tail = lines.filter(Boolean).slice(-2).join(' ');
    throw new Error(err || `MTProxyL: маршруты не настроены (${tail || `код ${r.exitCode}`})`);
  }
  const tests = new Map<string, string>();
  for (const l of lines) {
    const m = /^TG:test=([^=]+)=(.*)$/.exec(l);
    if (m?.[1]) tests.set(m[1], m[2] ?? '');
  }
  return {
    changed: lines.includes('TG:changed') || lines.includes('TG:diff'),
    tests,
    output,
  };
}
