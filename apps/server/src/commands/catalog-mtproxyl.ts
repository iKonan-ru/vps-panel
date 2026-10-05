import type { AccessEntry, CommandDef } from './types.js';
import { ENSURE_DOCKER, PROLOGUE, openPanelUrl, rndHex } from './util.js';

/**
 * Веб-панель MTProxyL (отдельный установщик mtproxyl-panel/install.sh). Он спрашивает всё
 * с терминала (/dev/tty), поэтому запускаем его под pty и отвечаем на вопросы по тексту
 * подсказок. Панель только на 127.0.0.1 и без шифрования (HTTP) - вход
 * через VPS Panel (поддомен с её входом и сертификатом, туннель агента до 127.0.0.1).
 */
const DRIVER = String.raw`
import os, pty, re, select, sys, time

USER = os.environ["MTP_USER"]; PASS = os.environ["MTP_PASSWORD"]
PORT = os.environ["MTP_PORT"]; HOST = os.environ["SERVER_HOST"]
ANSWERS = [
    ("Адрес API telemt", ""),
    ("Заголовок авторизации", ""),
    ("Всё равно продолжить", "n"),
    ("Логин администратора", USER),
    ("Пароль администратора", PASS),
    ("Повторите пароль", PASS),
    ("Путь к бинарнику telemt", ""),
    ("Имя systemd-службы", ""),
    ("Порт, на котором слушает панель", PORT),
    # "Вариант" спрашивается дважды: доступ - 2 (только 127.0.0.1), шифрование - 4 (HTTP)
    ("Вариант", ["2", "4"]),
    ("Способ", "1"),
    ("Путь панели", ""),
    ("Адрес или домен", HOST),
]
PROMPT_END = re.compile(r"(\]|\?|[а-яА-Яa-zA-Z0-9)])\s*:\s*$")

pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", sys.argv[1], "install"])
buf = b""
done = False  # после "Установка завершена" вопросов больше нет: итоговую сводку не трогаем
while True:
    r, _, _ = select.select([fd], [], [], 600)
    if not r:
        print("\nустановщик молчит 10 минут, прерываю", flush=True)
        os.kill(pid, 9); sys.exit(3)
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    # пароль в вывод не попадает, даже если терминал успел его отобразить
    os.write(1, chunk.replace(PASS.encode(), b"********"))
    buf = (buf + chunk)[-2000:]
    text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", buf).decode("utf-8", "replace")
    if "Установка завершена" in text:
        done = True
    tail = text.rsplit("\n", 1)[-1]
    if done or not PROMPT_END.search(tail):
        continue
    # строка с двоеточием на конце может быть просто разрезанным выводом ("Полезные команды:"):
    # настоящий вопрос ждёт ввода, вывод останавливается
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        continue
    for key, ans in ANSWERS:
        if key in tail:
            if isinstance(ans, list):
                if not ans:
                    print("\nлишний вопрос установщика: " + tail.strip(), flush=True)
                    os.kill(pid, 9); sys.exit(4)
                ans = ans.pop(0)
            if "ароль" in key:
                time.sleep(0.5)  # установщик выключает эхо после подсказки
            os.write(fd, (ans + "\n").encode())
            buf = b""
            break
    else:
        print("\nнеизвестный вопрос установщика: " + tail.strip(), flush=True)
        os.kill(pid, 9); sys.exit(4)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export const mtproxylCmd: CommandDef = {
  id: 'mtproxyl',
  title: 'MTProxyL',
  group: 'install',
  service: 'MTProxyL',
  description:
    'MTProto-прокси Telegram (движок telemt) вместе с веб-панелью MTProxyL: порт, домен маскировки, пользователи, Zapret2, доступ к панели. Если прокси уже стоит - ставится только панель.',
  params: [
    { name: 'MT_PORT', label: 'Порт прокси', type: 'port', default: '443', required: true },
    {
      name: 'MT_HOST',
      label: 'Адрес в ссылках (домен или пусто = IP)',
      type: 'string',
      hint: 'домен переносится между серверами, IP - нет',
      pattern: '^([a-z0-9.-]+)?$',
    },
    {
      name: 'MT_SNI',
      label: 'FakeTLS-домен',
      type: 'domain',
      default: 'autoscout24.ru',
      required: true,
      hint: 'под него маскируется рукопожатие',
    },
    {
      name: 'MT_USERS',
      label: 'Пользователи',
      type: 'string',
      default: 'default',
      required: true,
      hint: 'метки через запятую, каждому сгенерируется свой секрет',
      pattern: '^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$',
    },
    {
      name: 'MT_ENGINE',
      label: 'Движок',
      type: 'select',
      default: 'docker',
      options: [
        { value: 'docker', label: 'контейнер docker' },
        { value: 'binary', label: 'бинарник под systemd (без docker)' },
      ],
    },
    {
      name: 'MT_ZAPRET2',
      label: 'Zapret2 (обход на уровне TCP)',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: 'включить' },
        { value: 'no', label: 'выключить' },
      ],
    },
    {
      name: 'MT_ADTAG',
      label: 'Рекламная метка (32 hex)',
      type: 'string',
      pattern: '^([0-9a-f]{32})?$',
      hint: 'необязательно',
    },
    {
      name: 'MT_TG_TOKEN',
      label: 'Токен Telegram-бота',
      type: 'password',
      secret: true,
      hint: 'необязательно, вместе с ID администратора',
    },
    {
      name: 'MT_TG_ADMIN',
      label: 'Telegram ID администратора',
      type: 'string',
      pattern: '^([0-9]+)?$',
    },
    {
      name: 'MTP_USER',
      label: 'Логин администратора',
      type: 'string',
      default: 'admin',
      required: true,
      pattern: '^[A-Za-z0-9_.-]{2,40}$',
    },
    {
      name: 'MTP_PASSWORD',
      label: 'Пароль администратора',
      type: 'password',
      secret: true,
      required: true,
      generate: rndHex(12),
      hint: 'не короче 8 символов; сгенерирован, можно заменить',
    },
    {
      name: 'MTP_PORT',
      label: 'Порт панели',
      type: 'port',
      default: '8080',
      required: true,
      hint: 'только на 127.0.0.1: вход через VPS Panel',
    },
  ],
  timeoutSec: 45 * 60,
  files: () => ({ '/tmp/mtproxyl-panel-driver.py': DRIVER }),
  cleanup: ['/tmp/mtproxyl-panel-driver.py', '/tmp/mtproxyl-panel-install.sh'],
  script: `${PROLOGUE}
[ "\${#MTP_PASSWORD}" -ge 8 ] || { echo "пароль панели короче 8 символов" >&2; exit 2; }
if need mtproxyl; then
  say "MTProxyL уже установлен: прокси и пользователей не трогаю, ставлю или обновляю панель"
else
  if [ "$MT_ENGINE" = "docker" ]; then
${ENSURE_DOCKER}  fi
  say "Скачиваю установщик MTProxyL"
  fetch https://raw.githubusercontent.com/Liafanx/MTProxyL/main/install.sh -o /tmp/mtproxyl-install.sh
  args=(--mode manager --port "$MT_PORT" --sni "$MT_SNI" --engine "$MT_ENGINE" --zapret2 "$MT_ZAPRET2")
  [ -n "$MT_HOST" ] && args+=(--host "$MT_HOST")
  [ -n "$MT_ADTAG" ] && args+=(--ad-tag "$MT_ADTAG")
  if [ -n "$MT_TG_TOKEN" ] && [ -n "$MT_TG_ADMIN" ]; then args+=(--tgbot-token "$MT_TG_TOKEN" --tgbot-admin "$MT_TG_ADMIN"); fi
  IFS=',' read -ra users <<< "$MT_USERS"
  for u in "\${users[@]}"; do
    s=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')
    args+=(--secret "$u:$s")
  done
  say "Запускаю: mtproxyl install (аргументы без секретов и токена: --mode manager --port $MT_PORT --sni $MT_SNI --engine $MT_ENGINE --zapret2 $MT_ZAPRET2)"
  bash /tmp/mtproxyl-install.sh -- "\${args[@]}" </dev/null
  rm -f /tmp/mtproxyl-install.sh
fi
say "Ссылки для пользователей"
mtproxyl links 2>/dev/null || mtproxyl status 2>/dev/null || true
need python3 || apt_install python3
# sudo-rs (свежие Ubuntu): его visudo не принимает * в аргументах команд, а установщик панели
# пишет такие правила sudoers и падает. Переходим на классический sudo, как советует сам установщик.
sudo_v=""
if need sudo; then sudo_v="$(sudo --version 2>/dev/null || true) $(readlink -f "$(command -v sudo)")"; fi
case "$sudo_v" in
  *sudo-rs*)
    say "Системный sudo - sudo-rs: перехожу на классический sudo (sudo.ws), иначе установщик панели не примет свой sudoers"
    [ -x /usr/bin/sudo.ws ] || apt_install sudo
    update-alternatives --set sudo /usr/bin/sudo.ws
    sudo --version | sed -n 1p
    ;;
esac
say "Скачиваю установщик панели"
fetch https://raw.githubusercontent.com/Liafanx/MTProxyL/main/mtproxyl-panel/install.sh -o /tmp/mtproxyl-panel-install.sh
say "Запускаю установщик панели (отвечаю на его вопросы автоматически)"
export MTP_USER MTP_PASSWORD MTP_PORT SERVER_HOST
python3 /tmp/mtproxyl-panel-driver.py /tmp/mtproxyl-panel-install.sh
say "Проверяю службу панели"
systemctl is-active mtproxyl-panel
grep -E '^[[:space:]]*listen[[:space:]]*=' /etc/mtproxyl-panel/config.toml || true
say "Панель - только на 127.0.0.1:$MTP_PORT, вход через VPS Panel"
say "Готово"
`,
  preflight: `if command -v mtproxyl >/dev/null 2>&1; then echo "WARN|MTProxyL уже установлен: прокси и пользователи останутся как есть, поставится или обновится только панель"
elif ss -ltn | awk '{print $4}' | grep -q ":$MT_PORT$"; then echo "FAIL|порт $MT_PORT уже занят"
else echo "OK|порт $MT_PORT свободен"; fi
if [ "$MT_ENGINE" = "docker" ] && ! command -v docker >/dev/null 2>&1 && ! command -v mtproxyl >/dev/null 2>&1; then echo "WARN|docker не установлен, будет поставлен"; fi
case "$(sudo --version 2>/dev/null || true) $(readlink -f "$(command -v sudo || true)" || true)" in *sudo-rs*) echo "WARN|системный sudo - sudo-rs: будет переключён на классический sudo (sudo.ws), иначе панель не встанет";; esac
if systemctl is-active mtproxyl-panel >/dev/null 2>&1; then echo "WARN|панель уже установлена и работает: установщик обновит её, настройки сохранятся"; fi
if ss -ltn | awk '{print $4}' | grep -q ":$MTP_PORT$" && ! systemctl is-active mtproxyl-panel >/dev/null 2>&1; then echo "FAIL|порт панели $MTP_PORT уже занят"; else echo "OK|порт панели $MTP_PORT"; fi`,
  plan: (a) => [
    'Если MTProxyL ещё не установлен - скачать install.sh и установить менеджер аргументами (иначе прокси и пользователи остаются как есть)',
    `Прокси на порту ${a.MT_PORT}, FakeTLS ${a.MT_SNI}, движок ${a.MT_ENGINE === 'binary' ? 'бинарник' : 'docker (поставить, если его нет)'}`,
    `Пользователи: ${a.MT_USERS} (секреты генерируются на сервере)`,
    a.MT_ZAPRET2 === 'yes' ? 'Zapret2 включён' : 'Zapret2 выключен, SYN-лимитер по умолчанию',
    'Если системный sudo - sudo-rs (свежие Ubuntu), переключить на классический sudo.ws: иначе установщик панели не примет свой sudoers',
    `Веб-панель на 127.0.0.1:${a.MTP_PORT} без шифрования (HTTP), логин ${a.MTP_USER}: вход через VPS Panel (поддомен), снаружи панели нет`,
    'В конце - ссылки tg://proxy для пользователей (в выводе; потом - во вкладке MTProxyL)',
  ],
  access: ({ answers, server, panelUrl }) => {
    const panel: AccessEntry = {
      kind: 'mtproxyl-panel',
      title: 'Панель MTProxyL',
      fields: [
        // вход - через VPS Panel: панель на сервере только на 127.0.0.1
        { label: 'Адрес', value: openPanelUrl(panelUrl, server.name, 'mtproxyl') },
        { label: 'Логин', value: answers.MTP_USER ?? '' },
        { label: 'Пароль', value: answers.MTP_PASSWORD ?? '', secret: true },
      ],
    };
    // ссылки пользователей в "Доступы" не пишутся: они во вкладке MTProxyL
    return [panel];
  },
  after: 'Панель MTProxyL - в "Доступах" сервера, пользователи и их ссылки - во вкладке MTProxyL.',
};
