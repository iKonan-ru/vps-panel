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
    'Адрес в ссылках tg://proxy: \u00abАдрес для клиентов\u00bb сервера, свой адрес или внешний IP. С именем вместо IP ссылки клиентов переживут смену IP. Прокси не перезапускается.',
  params: [
    {
      name: 'MT_HOST_MODE',
      label: 'Адрес в ссылках',
      type: 'select',
      default: 'client',
      required: true,
      options: [
        { value: 'client', label: '\u00abАдрес для клиентов\u00bb сервера' },
        { value: 'custom', label: 'свой адрес' },
        { value: 'auto', label: 'внешний IP' },
      ],
    },
    {
      name: 'MT_HOST',
      label: 'Свой адрес',
      type: 'string',
      hint: 'имя или IPv4',
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
say "Ссылки MTProxy на личных страницах обновятся при синхронизации в течение нескольких минут"
`,
  preflight: `if command -v mtproxyl >/dev/null 2>&1; then echo "OK|MTProxyL установлен"; else echo "FAIL|MTProxyL не установлен"; fi
case "$MT_HOST_MODE" in
  client)
    if [ "$CLIENT_HOST" = "$SERVER_HOST" ]; then echo "WARN|у сервера не задан \u00abАдрес для клиентов\u00bb: в ссылках будет IP $SERVER_HOST"
    else ip=$(getent ahostsv4 "$CLIENT_HOST" 2>/dev/null | awk '{print $1; exit}')
      if [ "$ip" = "$SERVER_HOST" ]; then echo "OK|$CLIENT_HOST указывает на этот сервер"; else echo "WARN|$CLIENT_HOST указывает не на этот сервер ($SERVER_HOST)"; fi
    fi ;;
  custom) [ -n "$MT_HOST" ] && echo "OK|адрес $MT_HOST" || echo "FAIL|не задан свой адрес" ;;
  *) echo "OK|в ссылках будет внешний IP сервера" ;;
esac`,
  plan: (a) => [
    `Указать в ссылках ${a.MT_HOST_MODE === 'client' ? '\u00abАдрес для клиентов\u00bb' : a.MT_HOST_MODE === 'custom' ? a.MT_HOST || '<адрес>' : 'внешний IP'}; соединения не прерываются`,
    'Обновить ссылки MTProxy на личных страницах клиентов при синхронизации',
  ],
  resync: ['mtproxyl'],
  after:
    'Ссылки MTProxy на личных страницах обновятся при синхронизации. Старые ссылки работают, пока прежний адрес указывает на сервер.',
};
