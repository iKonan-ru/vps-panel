import type { CommandDef } from './types.js';
import { PROLOGUE, XUI_FUNCS } from './util.js';

/**
 * Панели сервисов, которые слушают наружу (поставлены вручную или чужим установщиком), - на
 * схему панели: только 127.0.0.1, вход через VPS Panel (поддомен, туннель агента). На неё ведёт
 * замечание аудита "панель открыта наружу"; команды установки 3X-UI и MTProxyL сразу ставят так.
 */
export const panelsLocalCmd: CommandDef = {
  id: 'panels-local',
  title: 'Панели сервисов - только через VPS Panel',
  group: 'maintain',
  description:
    'Панели 3X-UI и MTProxyL на этом сервере - только на 127.0.0.1: снаружи их больше нет, вход через VPS Panel (поддомен с её входом). Свой сервер подписок 3X-UI выключается - подписку отдаёт VPS Panel. Нужен агент 0.3.0+ (туннель).',
  params: [],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}
${XUI_FUNCS}
found=0
if [ -x /usr/local/x-ui/x-ui ]; then
  found=1
  say "3X-UI: панель только на 127.0.0.1, свой сервер подписок выключен (xray перезапустится)"
  port=$(/usr/local/x-ui/x-ui setting -show 2>/dev/null | awk -F': *' 'tolower($1) ~ /^[[:space:]]*port$/ {print $2; exit}' | tr -dc '0-9')
  systemctl stop x-ui
  /usr/local/x-ui/x-ui setting -listenIP 127.0.0.1 || echo "ВНИМАНИЕ: listenIP не задан" >&2
  xui_sub_off || echo "ВНИМАНИЕ: сервер подписок 3X-UI не выключен - выключи в её настройках" >&2
  systemctl start x-ui
  xui_panel_ufw_close "$port"
  xui_panel_ufw_close 2096
  systemctl is-active x-ui
  /usr/local/x-ui/x-ui setting -getListen 2>/dev/null || true
fi
cfg=/etc/mtproxyl-panel/config.toml
if [ -f "$cfg" ]; then
  found=1
  say "Панель MTProxyL: только на 127.0.0.1"
  cp -p "$cfg" "$cfg.before-local-$(date +%Y%m%d-%H%M%S)"
  sed -i -E 's/^([[:space:]]*listen[[:space:]]*=[[:space:]]*").*:([0-9]+")/\\1127.0.0.1:\\2/' "$cfg"
  grep -E '^[[:space:]]*listen[[:space:]]*=' "$cfg"
  systemctl restart mtproxyl-panel
  systemctl is-active mtproxyl-panel
fi
if [ "$found" = 0 ]; then
  say "На сервере нет ни 3X-UI, ни панели MTProxyL - менять нечего"
  exit 0
fi
if [ -x /usr/local/sbin/vps-portsync ]; then
  say "port-sync: закрываю ставшие ненужными порты панелей"
  /usr/local/sbin/vps-portsync | tail -n 20
fi
say "Готово: кнопка \\"Открыть панель\\" в VPS Panel ведёт на поддомен"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ]; then echo "WARN|3X-UI будет перезапущена: соединения VPN через неё прервутся на несколько секунд"; else echo "OK|3X-UI нет"; fi
if [ -f /etc/mtproxyl-panel/config.toml ]; then echo "OK|панель MTProxyL найдена: $(grep -E '^[[:space:]]*listen' /etc/mtproxyl-panel/config.toml | head -1 | tr -d ' ')"; else echo "OK|панели MTProxyL нет"; fi`,
  plan: () => [
    '3X-UI (если есть): webListen = 127.0.0.1, свой сервер подписок выключить, перезапуск (VPN прервётся на несколько секунд)',
    'Панель MTProxyL (если есть): listen = 127.0.0.1:<порт> в /etc/mtproxyl-panel/config.toml (копия рядом), перезапуск панели; сам прокси не трогается',
    'port-sync: закрыть порты панелей снаружи',
  ],
  after:
    'Через минуту-другую (следующий снимок) "Открыть панель" в карточке сервера откроет панель через поддомен VPS Panel; прямой адрес по IP больше не работает.',
};

/**
 * Старые сертификаты сервера: IP-сертификаты, которые агент выпускал раньше через acme.sh в
 * /etc/vps-certs, хук продления /usr/local/bin/vps-cert-reload и копия у панели MTProxyL.
 * Сейчас агент сертификатов не выпускает и не продлевает их копии; панели 3X-UI и MTProxyL
 * слушают 127.0.0.1 и открываются через VPS Panel, HTTPS им не нужен. Порядок: сначала панели
 * отцепляются от файлов (иначе 3X-UI не поднимется без сертификата), потом файлы удаляются.
 */
export const legacyCertsCmd: CommandDef = {
  id: 'legacy-certs',
  title: 'Убрать старые сертификаты',
  group: 'maintain',
  description:
    'Снять IP-сертификаты, которые агент выпускал раньше (/etc/vps-certs, acme.sh, хук vps-cert-reload): панели 3X-UI и MTProxyL переходят на HTTP на 127.0.0.1 (вход через VPS Panel, как на новых серверах), затем сертификаты и хук удаляются.',
  params: [],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}
acme=/root/.acme.sh/acme.sh
found=0
if [ -x /usr/local/x-ui/x-ui ] && /usr/local/x-ui/x-ui setting -getCert 2>/dev/null | grep -q /etc/vps-certs; then
  found=1
  say "3X-UI: панель без HTTPS (на 127.0.0.1, вход через VPS Panel), перезапуск - VPN прервётся на несколько секунд"
  systemctl stop x-ui
  /usr/local/x-ui/x-ui cert -reset
  systemctl start x-ui
  systemctl is-active x-ui
  /usr/local/x-ui/x-ui setting -getCert 2>/dev/null || true
fi
cfg=/etc/mtproxyl-panel/config.toml
if [ -f "$cfg" ] && grep -q '^\\[tls\\]' "$cfg"; then
  found=1
  say "Панель MTProxyL: без HTTPS (на 127.0.0.1, вход через VPS Panel)"
  cp -p "$cfg" "$cfg.before-http-$(date +%Y%m%d-%H%M%S)"
  # секция [tls] - до следующей секции или конца файла
  awk '/^\\[/{skip = ($0 == "[tls]")} !skip' "$cfg" > "$cfg.tmp" && cat "$cfg.tmp" > "$cfg" && rm -f "$cfg.tmp"
  rm -f /var/lib/mtproxyl-panel/certs/panel.crt /var/lib/mtproxyl-panel/certs/panel.key
  systemctl restart mtproxyl-panel
  sleep 1
  systemctl is-active mtproxyl-panel
fi
if [ -d /etc/vps-certs ]; then
  found=1
  for d in $(ls /etc/vps-certs); do
    say "acme.sh: снимаю сертификат $d"
    if [ -x "$acme" ]; then
      "$acme" --home /root/.acme.sh --remove -d "$d" --ecc >/dev/null 2>&1 || "$acme" --home /root/.acme.sh --remove -d "$d" >/dev/null 2>&1 || true
    fi
    rm -rf "/root/.acme.sh/\${d}_ecc" "/root/.acme.sh/$d"
  done
  rm -rf /etc/vps-certs
fi
if [ -e /usr/local/bin/vps-cert-reload ]; then
  found=1
  rm -f /usr/local/bin/vps-cert-reload
  say "Хук vps-cert-reload удалён"
fi
# acme.sh больше ни для чего не нужен - убрать вместе с его заданием в cron
if [ -x "$acme" ] && ! "$acme" --home /root/.acme.sh --list 2>/dev/null | awk 'NR > 1 && NF' | grep -q .; then
  found=1
  say "acme.sh: сертификатов не осталось - удаляю его и задание в cron"
  "$acme" --home /root/.acme.sh --uninstall >/dev/null 2>&1 || true
  rm -rf /root/.acme.sh
fi
if [ "$found" = 0 ]; then
  say "Старых сертификатов на сервере нет - менять нечего"
  exit 0
fi
say "Готово: через минуту-другую (следующий снимок) панели откроются через VPS Panel по HTTP на 127.0.0.1"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ] && /usr/local/x-ui/x-ui setting -getCert 2>/dev/null | grep -q /etc/vps-certs; then echo "WARN|3X-UI использует старый сертификат: перейдёт на HTTP, перезапуск - VPN прервётся на несколько секунд"; else echo "OK|3X-UI старый сертификат не использует"; fi
if [ -f /etc/mtproxyl-panel/config.toml ] && grep -q '^\\[tls\\]' /etc/mtproxyl-panel/config.toml; then echo "WARN|панель MTProxyL перейдёт на HTTP (перезапуск панели; сам прокси Telegram не трогается)"; else echo "OK|панель MTProxyL уже без HTTPS (или её нет)"; fi
if [ -d /etc/vps-certs ]; then echo "OK|старые сертификаты: $(ls /etc/vps-certs | tr '\\n' ' ')"; else echo "OK|/etc/vps-certs нет"; fi
if [ -e /usr/local/bin/vps-cert-reload ]; then echo "OK|хук vps-cert-reload есть - будет удалён"; fi`,
  plan: () => [
    '3X-UI (если указывает на /etc/vps-certs): x-ui cert -reset, перезапуск - VPN прервётся на несколько секунд',
    'Панель MTProxyL (если есть [tls]): секция [tls] убирается (копия конфига рядом), перезапуск панели; прокси Telegram не трогается',
    'acme.sh: снять сертификаты из /etc/vps-certs, удалить /etc/vps-certs и хук /usr/local/bin/vps-cert-reload',
    'acme.sh без сертификатов - удалить вместе с заданием в cron',
  ],
  after:
    'Через минуту-другую "Открыть панель" откроет панели через VPS Panel по HTTP; во вкладке "Сертификаты" старых IP-сертификатов больше не будет.',
};
