import type { CommandDef } from './types.js';
import { PROLOGUE, XUI_FUNCS } from './util.js';

/**
 * Панели сервисов, которые слушают наружу (поставлены вручную или чужим установщиком), - на
 * схему панели: только 127.0.0.1, вход через VPS Panel (поддомен, туннель агента). На неё ведёт
 * замечание аудита "панель открыта наружу"; команды установки 3X-UI и MTProxyL сразу ставят так.
 */
export const panelsLocalCmd: CommandDef = {
  id: 'panels-local',
  title: 'Закрыть панели сервисов снаружи',
  group: 'maintain',
  description:
    'Панели 3X-UI и MTProxyL станут доступны только через VPS Panel, сервер подписок 3X-UI выключится. Нужен агент 0.3.0 или новее.',
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
  xui_sub_off || echo "ВНИМАНИЕ: сервер подписок 3X-UI не выключен, выключите его в настройках 3X-UI" >&2
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
say "Готово: панели открываются кнопкой \\"Открыть\\" на странице сервера"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ]; then echo "WARN|3X-UI перезапустится, соединения VPN прервутся на несколько секунд"; else echo "OK|3X-UI не установлен"; fi
if [ -f /etc/mtproxyl-panel/config.toml ]; then echo "OK|панель MTProxyL найдена: $(grep -E '^[[:space:]]*listen' /etc/mtproxyl-panel/config.toml | head -1 | tr -d ' ')"; else echo "OK|панель MTProxyL не установлена"; fi`,
  plan: () => [
    'Закрыть панель 3X-UI снаружи и выключить её сервер подписок; VPN прервётся на несколько секунд',
    'Закрыть панель MTProxyL снаружи; прокси продолжит работать',
    'Закрыть порты панелей',
  ],
  after:
    'Кнопка \u00abОткрыть\u00bb у панелей на странице сервера заработает в течение 5\u00a0минут. Прямой адрес по IP больше не работает.',
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
  title: 'Удалить старые сертификаты',
  group: 'maintain',
  description:
    'Удаляет IP-сертификаты, которые агент выпускал раньше. Панели 3X-UI и MTProxyL открываются через VPS Panel, как на новых серверах.',
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
say "Готово: в течение 5 минут панели будут открываться через VPS Panel"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ] && /usr/local/x-ui/x-ui setting -getCert 2>/dev/null | grep -q /etc/vps-certs; then echo "WARN|3X-UI использует старый сертификат: она перезапустится, соединения VPN прервутся на несколько секунд"; else echo "OK|3X-UI не использует старый сертификат"; fi
if [ -f /etc/mtproxyl-panel/config.toml ] && grep -q '^\\[tls\\]' /etc/mtproxyl-panel/config.toml; then echo "WARN|панель MTProxyL перезапустится, прокси продолжит работать"; else echo "OK|панель MTProxyL не использует старый сертификат"; fi
if [ -d /etc/vps-certs ]; then echo "OK|старые сертификаты: $(ls /etc/vps-certs | tr '\\n' ' ')"; else echo "OK|старых сертификатов нет"; fi
if [ -e /usr/local/bin/vps-cert-reload ]; then echo "OK|хук продления vps-cert-reload будет удалён"; fi`,
  plan: () => [
    'Отключить старый сертификат в 3X-UI; VPN прервётся на несколько секунд',
    'Отключить старый сертификат в панели MTProxyL; прокси продолжит работать',
    'Удалить старые сертификаты и хук продления',
    'Удалить acme.sh, если в нём не осталось сертификатов',
  ],
  after: 'Старые IP-сертификаты пропадут с вкладки \u00abСертификаты\u00bb в течение 5\u00a0минут.',
};
