import type { CommandDef } from './types.js';
import { PROLOGUE, XUI_FUNCS, openPanelUrl, rndPassword, rndPath, rndPort } from './util.js';

export const xuiCmd: CommandDef = {
  id: 'xui',
  title: '3X-UI',
  group: 'install',
  service: '3X-UI',
  description:
    'Панель Xray (3X-UI) официальным установщиком в неинтерактивном режиме: логин, пароль, порт и путь задаются сразу. Панель слушает только 127.0.0.1 без HTTPS - вход через VPS Panel (поддомен с её входом и сертификатом), снаружи её нет; свой сервер подписок 3X-UI выключен - подписку отдаёт VPS Panel.',
  params: [
    {
      name: 'XUI_USERNAME',
      label: 'Логин панели',
      type: 'string',
      default: 'admin',
      required: true,
      pattern: '^[A-Za-z0-9_.-]{3,32}$',
    },
    {
      name: 'XUI_PASSWORD',
      label: 'Пароль панели',
      type: 'password',
      generate: rndPassword,
      required: true,
      secret: true,
      hint: 'сгенерирован; сохрани, панель его не хранит',
    },
    {
      name: 'XUI_PANEL_PORT',
      label: 'Порт панели',
      type: 'port',
      generate: rndPort(),
      required: true,
    },
    {
      name: 'XUI_WEB_BASE_PATH',
      label: 'Путь панели',
      type: 'string',
      generate: rndPath,
      required: true,
      pattern: '^/[A-Za-z0-9_-]{6,64}/$',
      hint: 'длинный случайный, чтобы панель не нашли сканером',
    },
  ],
  timeoutSec: 20 * 60,
  script: `${PROLOGUE}
${XUI_FUNCS}
say "Скачиваю установщик 3X-UI"
fetch https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh -o /tmp/xui-install.sh
# без HTTPS - панель слушает только 127.0.0.1, вход через VPS Panel
export XUI_NONINTERACTIVE=1 XUI_ENABLE_FAIL2BAN=false XUI_SSL_MODE=none
export XUI_USERNAME XUI_PASSWORD XUI_PANEL_PORT
# установщик ждёт путь без косых
export XUI_WEB_BASE_PATH="$(echo "$XUI_WEB_BASE_PATH" | tr -d '/')"
say "Запускаю установщик (неинтерактивно)"
apt_wait
# установщик 3.10+ печатает пароль и токен API открытым текстом - в журнал панели они не идут
bash /tmp/xui-install.sh </dev/null 2>&1 | sed -u -E 's/((Password|API Token)[^:]*:[[:space:]]*).*/\\1********/'
rm -f /tmp/xui-install.sh
# итог установщика 3.10+: логин, пароль и токен API открытым текстом. Панели он не нужен (токен
# агент берёт сам, доступы - в "Доступах" панели), на диске не оставляем. Токен "install"
# перевыпускается с выбросом вывода - прежний недействителен, новый не знает никто
if grep -q '^XUI_API_TOKEN=' /etc/x-ui/install-result.env 2>/dev/null; then
  /usr/local/x-ui/x-ui setting -getApiToken -tokenName install >/dev/null 2>&1 || true
fi
rm -f /etc/x-ui/install-result.env
say "Панель - только на 127.0.0.1, свой сервер подписок 3X-UI - выключен"
systemctl stop x-ui
/usr/local/x-ui/x-ui setting -listenIP 127.0.0.1 || echo "ВНИМАНИЕ: listenIP не задан" >&2
xui_sub_off || echo "ВНИМАНИЕ: сервер подписок 3X-UI не выключен - выключи в её настройках" >&2
systemctl start x-ui
xui_panel_ufw_close "$XUI_PANEL_PORT"
xui_panel_ufw_close 2096
say "Проверяю"
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -getListen 2>/dev/null || true
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei 'port|webBasePath' || true
say "Готово"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ]; then echo "FAIL|3X-UI уже установлен: переустановка через этот скрипт перезапишет настройки; удали 3X-UI или используй обновление из меню x-ui"; else echo "OK|3X-UI не установлен"; fi
if ss -ltn | awk '{print $4}' | grep -q ":$XUI_PANEL_PORT$"; then echo "FAIL|порт $XUI_PANEL_PORT уже занят"; else echo "OK|порт $XUI_PANEL_PORT свободен"; fi
if command -v python3 >/dev/null 2>&1; then echo "OK|python3 есть (выключить сервер подписок 3X-UI)"; else echo "WARN|python3 нет - будет поставлен"; fi`,
  plan: (a) => [
    'Скачать официальный install.sh 3X-UI и запустить в неинтерактивном режиме',
    `Логин ${a.XUI_USERNAME}, порт ${a.XUI_PANEL_PORT}, путь ${a.XUI_WEB_BASE_PATH}`,
    'Панель - только на 127.0.0.1 без HTTPS: вход через VPS Panel (поддомен), снаружи панели нет',
    'Свой сервер подписок 3X-UI выключить: подписку клиентам отдаёт VPS Panel',
    'fail2ban для панели не ставить установщиком (jail xui-panel настраивает панель через "Исправить проблемы")',
    'port-sync откроет порты inbound-ов автоматически (порт панели - нет: она на 127.0.0.1)',
  ],
  access: ({ server, answers, panelUrl }) => ({
    kind: 'xui',
    title: 'Панель 3X-UI',
    fields: [
      // вход - через VPS Panel: поддомен с её входом, панель на сервере - только 127.0.0.1
      { label: 'Адрес', value: openPanelUrl(panelUrl, server.name, 'xui') },
      { label: 'Логин', value: answers.XUI_USERNAME ?? '' },
      { label: 'Пароль', value: answers.XUI_PASSWORD ?? '', secret: true },
    ],
  }),
  // новая база 3X-UI: прежний API-токен панели не подходит, он выпустится заново при первом обращении
  forgetsAccess: ['xui-api'],
  after:
    'Кнопка "Открыть панель" появится в карточке сервера после следующего снимка (до 5 минут) или по кнопке обновления: вход через VPS Panel, затем логин и пароль 3X-UI из формы.',
};
