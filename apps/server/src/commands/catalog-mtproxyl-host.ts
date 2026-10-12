import type { CommandDef } from './types.js';
import { PROLOGUE } from './util.js';

/**
 * Адрес в ссылках MTProxyL (CUSTOM_IP): имя сервера из "Адреса для клиентов" вместо IP - тогда
 * смена IP сервера не ломает ссылки у людей. После запуска ссылки MTProxy на личных страницах
 * перевыпускаются сверкой (resync).
 */
export const mtproxylHostCmd: CommandDef = {
  id: 'mtproxyl-host',
  title: 'MTProxyL: адрес в ссылках',
  group: 'maintain',
  description:
    'Какой адрес MTProxyL ставит в ссылки tg://proxy: имя сервера из "Адреса для клиентов" (смена IP - правка DNS, ссылки у людей работают), свой адрес или автоопределение (внешний IP). Прокси не перезапускается; уже выданные ссылки со старым адресом работают, пока он жив.',
  params: [
    {
      name: 'MT_HOST_MODE',
      label: 'Адрес в ссылках',
      type: 'select',
      default: 'client',
      required: true,
      options: [
        { value: 'client', label: 'адрес для клиентов сервера (имя из "Обзора")' },
        { value: 'custom', label: 'свой адрес' },
        { value: 'auto', label: 'автоопределение (внешний IP)' },
      ],
    },
    {
      name: 'MT_HOST',
      label: 'Свой адрес (имя или IPv4)',
      type: 'string',
      pattern: '^([a-zA-Z0-9-]+\\.)+[a-zA-Z0-9-]+$',
      showIf: { MT_HOST_MODE: 'custom' },
    },
  ],
  timeoutSec: 2 * 60,
  script: `${PROLOGUE}
case "$MT_HOST_MODE" in
  client) h="$CLIENT_HOST" ;;
  custom) h="$MT_HOST" ;;
  *) h="" ;;
esac
say "MTProxyL: адрес в ссылках - \${h:-автоопределение}"
MTPROXYL_ASSUME_YES=1 MTPROXYL_NONINTERACTIVE=true mtproxyl settings set CUSTOM_IP "$h"
mtproxyl settings list 2>/dev/null | grep -i custom_ip || true
say "Ссылки MTProxy на личных страницах обновит сверка (в течение нескольких минут)"
`,
  preflight: `if command -v mtproxyl >/dev/null 2>&1; then echo "OK|MTProxyL установлен"; else echo "FAIL|MTProxyL на сервере нет"; fi
case "$MT_HOST_MODE" in
  client)
    if [ "$CLIENT_HOST" = "$SERVER_HOST" ]; then echo "WARN|у сервера не задано имя в \\"Адресе для клиентов\\" (Обзор): в ссылки пойдёт IP $SERVER_HOST"
    else ip=$(getent ahostsv4 "$CLIENT_HOST" 2>/dev/null | awk '{print $1; exit}')
      if [ "$ip" = "$SERVER_HOST" ]; then echo "OK|$CLIENT_HOST указывает на этот сервер"; else echo "WARN|$CLIENT_HOST указывает на \${ip:-ничто}, а сервер - $SERVER_HOST"; fi
    fi ;;
  custom) [ -n "$MT_HOST" ] && echo "OK|адрес $MT_HOST" || echo "FAIL|не задан свой адрес" ;;
  *) echo "OK|автоопределение: внешний адрес сервера" ;;
esac`,
  plan: (a) => [
    `mtproxyl settings set CUSTOM_IP ${a.MT_HOST_MODE === 'client' ? '<адрес для клиентов>' : a.MT_HOST_MODE === 'custom' ? a.MT_HOST || '<адрес>' : '"" (автоопределение)'}: движок перечитывает конфиг, соединения не рвутся`,
    'Сверка перевыпустит ссылки MTProxy на личных страницах клиентов этого сервера',
  ],
  resync: ['mtproxyl'],
  after:
    'Ссылки MTProxy на личных страницах обновятся сверкой; люди со старой ссылкой работают, пока жив прежний адрес.',
};
