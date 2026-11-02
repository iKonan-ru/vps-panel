#!/usr/bin/env python3
"""Очистка сервера: один исполнитель для агента и консольной команды.

Происхождение старых VPN-установок неизвестно: они удаляются только по явному
выбору. Общие системные журналы, защита и сторонние ресурсы сохраняются.
"""
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile


class CleanupError(Exception):
    pass


# 3x-ipl-backend.conf задаёт DEFAULT backend для всех jail, включая SSH: сохраняется.
DEFINITIONS = {
    "xui": ("3X-UI: Xray, пользователи и настройки", False,
            ["/usr/local/x-ui", "/etc/x-ui", "/etc/default/x-ui", "/usr/bin/x-ui", "/usr/local/bin/x-ui",
             "/var/log/x-ui", "/etc/fail2ban/jail.d/xui-panel.conf", "/etc/fail2ban/filter.d/xui-panel.conf",
             "/etc/fail2ban/jail.d/3x-ipl.conf", "/etc/fail2ban/filter.d/3x-ipl.conf",
             "/etc/fail2ban/action.d/3x-ipl.conf"],
            ["x-ui.service"], []),
    "mtproxyl": ("MTProxyL: прокси, веб-панель, ключи и настройки", False,
                 ["/opt/mtproxyl", "/etc/mtproxyl-panel", "/var/lib/mtproxyl-panel",
                  "/usr/local/bin/mtproxyl", "/usr/local/bin/mtproxyl-panel", "/etc/profile.d/mtproxyl.sh",
                  "/etc/sudoers.d/mtproxyl-panel", "/etc/sudoers.d/mtproxyl-panel-mtproxyl",
                  "/etc/sudoers.d/mtproxyl-panel-quiet"],
                 ["mtproxyl.service", "mtproxyl-panel.service", "mtproxyl-telemt.service"], ["mtproxyl-panel", "mtproxyl-tgbot"]),
    "wdtt": ("WDTT: сервис, база паролей и ключи", False,
             ["/etc/wdtt", "/usr/local/bin/wdtt-server", "/etc/sysctl.d/99-wdtt.conf", "/var/log/wdtt-install.log"],
             ["wdtt.service"], []),
    "openflux": ("OpenFlux: все каналы, данные и ключи", False,
                 ["/opt/openflux-node", "/etc/openflux-node", "/var/lib/openflux-node"],
                 ["openflux-node@.service", "openflux-node-update.service", "openflux-node-update.timer"], ["openflux-node"]),
    "naive": ("Прокси для браузера: пользователи, ключи и сертификаты", True,
              ["/opt/vps-naive", "/etc/vps-naive", "/var/lib/vps-naive", "/usr/local/sbin/vps-naive-cert"],
              ["vps-naive.service", "vps-naive-cert.service", "vps-naive-cert.timer"], ["vps-naive"]),
    "portsync": ("Автоматическое управление портами", True,
                 ["/usr/local/sbin/vps-portsync", "/etc/vps-portsync.conf", "/var/lib/vps-portsync"],
                 ["vps-portsync.service", "vps-portsync.timer", "vps-portsync-xui.path",
                  "vps-portsync-xui.service", "vps-portsync-docker-watch.service"], []),
    "agent": ("Агент: ключ подключения, настройки и прежние версии", True,
              ["/etc/vps-agent", "/usr/local/bin/vps-agent", "/usr/local/bin/vps-agent.prev", "/usr/local/bin/vps-agent.new"],
              ["vps-agent.service"], []),
    "cert-acme": ("acme.sh: все сертификаты, ключи аккаунта и продление", False,
                  ["/root/.acme.sh"], [], []),
    "cert-xui": ("Сертификаты и ключи в /root/cert", False, ["/root/cert"], [], []),
    "cert-certbot": ("Certbot: все сертификаты, ключи аккаунта и продление", False,
                     ["/etc/letsencrypt", "/var/lib/letsencrypt", "/var/log/letsencrypt"],
                     ["certbot.timer", "certbot.service"], []),
}
UNIT_DIRS = ("/etc/systemd/system/", "/usr/lib/systemd/system/")
PRESERVED = ["Обновления ОС и автообновления безопасности", "SSH, ключи владельца, fail2ban и правила firewall",
             "Сторонние приложения и общие системные журналы"]
SSH_BLOCK = "\n# Доступ root по паролю\nMatch User root\n    PermitRootLogin yes\n    PasswordAuthentication yes\n    AuthenticationMethods any\n"
STATE_DIR = "/run/vps-uninstall"


class Engine:
    def __init__(self, root="", panel_root="/opt/vps-panel"):
        self.root = root
        self.panel_root = panel_root.rstrip("/")
        if not self.panel_root.startswith("/opt/") or ".." in Path(self.panel_root).parts:
            raise CleanupError("каталог панели должен находиться внутри /opt")

    def path(self, name):
        return Path(self.root + name)

    def run(self, args, *, input=None, check=True, env=None):
        try:
            p = subprocess.run(args, input=input, text=True, capture_output=True, timeout=180, env=env)
        except (OSError, subprocess.TimeoutExpired):
            raise CleanupError("не удалось выполнить " + args[0]) from None
        if check and p.returncode:
            # Утилиты могут напечатать конфиг или пароль: наружу идёт только имя и код.
            raise CleanupError(f"{args[0]}: код {p.returncode}; очистка не завершена")
        return p

    def has(self, name):
        return shutil.which(name) is not None

    def exists(self, name):
        return os.path.lexists(self.path(name))

    def text(self, name):
        try:
            return self.path(name).read_text()
        except FileNotFoundError:
            return ""

    def write(self, name, text, mode=0o600):
        self.safe_path(name)
        p = self.path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "w") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def safe_path(self, name):
        p = self.path(name)
        for parent in [p, *p.parents]:
            if parent.is_symlink():
                raise CleanupError(f"{name}: символическая ссылка; сначала проверить её назначение")
        if p.is_dir():
            for line in self.text("/proc/self/mountinfo").splitlines():
                mount = line.split()[4].replace("\\040", " ")
                if mount == name or mount.startswith(name.rstrip("/") + "/"):
                    raise CleanupError(f"{name}: внутри есть точка монтирования; удаление запрещено")

    def remove(self, name):
        p = self.path(name)
        # Удаляется только сама ссылка, её цель не обходится.
        if p.is_symlink():
            for parent in p.parents:
                if parent.is_symlink():
                    raise CleanupError(f"{name}: родитель является ссылкой")
            p.unlink()
            return
        self.safe_path(name)
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()

    def docker(self):
        if not self.has("docker"):
            if self.exists("/var/lib/docker"):
                raise CleanupError("данные Docker есть, но команда docker недоступна")
            return []
        ids = self.run(["docker", "ps", "-aq", "--no-trunc"]).stdout.split()
        return json.loads(self.run(["docker", "inspect", *ids]).stdout) if ids else []

    def definitions(self):
        d = dict(DEFINITIONS)
        title, owned, paths, units, users = d["mtproxyl"]
        paths = paths + ["/opt/mtproxyl-tgbot", "/opt/mtproxyl-nginx", "/var/www/mtproxyl-selfmask",
                         "/var/log/mtproxyl-nginx", "/var/lib/mtproxyl-nginx", "/usr/local/sbin/mtproxyl-syn-limit.sh",
                         "/usr/local/sbin/mtproxyl-bridge-watch.sh", "/usr/local/sbin/mtproxyl-zapret2-start.sh",
                         "/etc/sudoers.d/mtproxyl-tgbot", "/etc/sudoers.d/mtproxyl-panel-engine"]
        paths += ["/etc/sysctl.d/99-mtproxyl-" + n + ".conf" for n in ("zapret2", "wscale", "keepalive", "meko-opt")]
        units = list(units)
        for p in self.path("/etc/systemd/system").glob("mtproxyl*"):
            if p.suffix in (".service", ".timer", ".path") and p.name not in units:
                units.append(p.name)
        # Движок может иметь выбранное владельцем имя службы; определяется по ExecStart.
        for p in self.path("/etc/systemd/system").glob("*.service"):
            if p.is_file() and not p.is_symlink() and re.search(r"(?m)^ExecStart=.*?/opt/mtproxyl/engine/", p.read_text()):
                if p.name not in units:
                    units.append(p.name)
        d["mtproxyl"] = title, owned, paths, units, users
        d["panel"] = ("VPS Panel: база, резервные копии, ключи и сертификаты", True,
                      [self.panel_root, "/usr/local/bin/vps-panel", "/etc/fail2ban/jail.d/vps-panel.conf",
                       "/etc/fail2ban/filter.d/vps-panel.conf"],
                      ["vps-panel-update.path", "vps-panel-update.service"], [])
        return d

    def scan(self):
        containers = self.docker()
        items = []
        for key, (title, owned, paths, units, users) in self.definitions().items():
            paths = list(paths)
            for unit in units:
                paths.extend(d + unit for d in UNIT_DIRS)
                paths.extend(d + unit + ".d" for d in UNIT_DIRS)
                for link in self.path("/etc/systemd/system").glob("*/*"):
                    if link.name == unit and link.is_symlink():
                        paths.append(str(link)[len(self.root):])
            paths = sorted({p for p in paths if self.exists(p)})
            present_users = [u for u in users if self.run(["getent", "passwd", u], check=False).returncode == 0]
            present_groups = [u for u in users if self.run(["getent", "group", u], check=False).returncode == 0]
            if not paths and not present_users and not present_groups:
                continue
            item = dict(id=key, title=title, owned=owned, paths=paths, containers=[], blockers=[], units=units,
                        users=present_users, groups=present_groups)
            if key == "xui" and re.search(r"XUI_DB_TYPE\s*=\s*['\"]?postgres", self.text("/etc/default/x-ui")):
                item["blockers"].append("3X-UI использует PostgreSQL: сначала перенести или удалить её базу отдельно; общий PostgreSQL не удаляется")
            if key == "mtproxyl" and any(self.exists(p) for p in (
                    "/etc/wireguard/mtpwarp.conf", "/etc/amnezia/amneziawg/mtpdonor.conf",
                    "/etc/amnezia/amneziawg/mtpawg.conf")):
                item["blockers"].append("сначала отключите дополнительные туннели MTProxyL (WARP, donor, AWG), чтобы сохранить стороннюю маршрутизацию")
            items.append(item)
        by_id = {i["id"]: i for i in items}
        preserved = list(PRESERVED)
        blockers = []
        panel = self.exists(self.panel_root + "/compose.yml") or self.exists(self.panel_root + "/.env")
        for c in containers:
            name = c["Name"].lstrip("/")
            labels = c.get("Config", {}).get("Labels") or {}
            image = c.get("Config", {}).get("Image", "")
            key, title, owned = "", "", False
            if labels.get("com.docker.compose.project") == "vps-panel" and labels.get("com.docker.compose.service") in ("panel", "caddy"):
                key, title, owned, panel = "panel", "VPS Panel: база, резервные копии, ключи и сертификаты", True, True
                workdir = labels.get("com.docker.compose.project.working_dir")
                if workdir and workdir != self.panel_root:
                    blockers.append("каталог установки Docker не совпадает с каталогом панели")
            elif re.fullmatch(r"amnezia-awg2(?:-\d{1,5})?", name):
                key, title = "container:" + name, "AmneziaWG: " + name
            elif any(x in image.lower() for x in ("/3x-ui", "/mtproxyl", "/telemt")) or name == "mtproxyl":
                key, title = "container:" + name, "VPN/прокси в контейнере: " + name
            if not key:
                preserved.append("Контейнер: " + name)
                continue
            if key not in by_id:
                item = dict(id=key, title=title, owned=owned, paths=[], containers=[], blockers=[], units=[], users=[], groups=[])
                if name.startswith("amnezia-awg2") and self.exists("/opt/amnezia/" + name):
                    item["paths"].append("/opt/amnezia/" + name)
                items.append(item)
                by_id[key] = item
            by_id[key]["containers"].append(c["Id"])
        # Данные контейнера могут лежать отдельно от каталога установки. Их происхождение
        # неизвестно, поэтому тома и отдельные bind-каталоги требуют собственного выбора.
        managed_containers = {cid for i in items for cid in i["containers"]}
        known_paths = [p for i in items for p in i["paths"]]
        for c in containers:
            if c["Id"] not in managed_containers:
                continue
            for m in c.get("Mounts", []):
                if m.get("Type") == "volume":
                    key = "volume:" + m["Name"]
                    if key not in by_id:
                        own_volume = m["Name"] in ("vps-panel_caddy_data", "vps-panel_caddy_config") and c["Id"] in by_id.get("panel", {}).get("containers", [])
                        item = dict(id=key, title="Том Docker целиком: " + m["Name"], owned=own_volume,
                                    paths=[], containers=[], blockers=[], units=[], users=[], groups=[], volume=m["Name"])
                        items.append(item)
                        by_id[key] = item
                elif m.get("Type") == "bind":
                    p = m.get("Source", "")
                    if any(p == k or p.startswith(k + "/") for k in known_paths):
                        continue
                    if not self.path(p).is_dir() or not re.match(r"^/(?:opt|srv)/[^/]+(?:/.*)?$|^/home/[^/]+/[^/]+(?:/.*)?$", p):
                        preserved.append("Общий путь контейнера: " + p)
                        continue
                    key = "bind:" + hashlib.sha256(p.encode()).hexdigest()[:16]
                    if key not in by_id:
                        item = dict(id=key, title="Данные контейнера целиком: " + p, owned=False,
                                    paths=[p], containers=[], blockers=[], units=[], users=[], groups=[])
                        items.append(item)
                        by_id[key] = item
        if panel:
            dbfile = self.path(self.panel_root + "/data/panel.db")
            if dbfile.exists():
                try:
                    with contextlib.closing(sqlite3.connect(dbfile.as_uri() + "?mode=ro", uri=True)) as db:
                        agent = json.loads(self.text("/etc/vps-agent/agent.json") or "{}")
                        sid = agent.get("serverId", "")
                        if not sid:
                            saved_id = db.execute("SELECT value FROM setting WHERE key='uninstall_panel_server_id'").fetchone()
                            sid = saved_id[0] if saved_id else ""
                        links = db.execute("SELECT COUNT(*) FROM vless_cascade WHERE entry_server_id=? OR exit_server_id=? OR ?=''", (sid, sid, sid)).fetchone()[0]
                        routes = db.execute("SELECT value FROM setting WHERE key IN ('xray_outbound','xray_spares')").fetchall()
                        pending = db.execute("SELECT value FROM setting WHERE key LIKE 'uninstall_cascades:%'").fetchall()
                        peers = db.execute("SELECT COUNT(*) FROM server s WHERE s.id<>? AND (s.agent_token_hash IS NOT NULL OR s.registration_token IS NOT NULL OR NOT EXISTS (SELECT 1 FROM setting k WHERE k.key='uninstall_detached:'||s.id AND k.value=s.host||':'||s.ssh_port))", (sid,)).fetchone()[0]
                        if links or peers or any(json.loads(v or "null") for (v,) in routes + pending):
                            blockers.append("в панели остались сетевые связи: сначала откройте 'Очистить сервер от панели' в карточке сервера панели и нажмите 'Снять связи'")
                except (sqlite3.Error, ValueError):
                    blockers.append("не удалось проверить связи в базе панели; очистка запрещена до проверки базы")
            if self.has("docker"):
                # Старые версии панели тоже содержат её код; чужие образы не перечисляются.
                for repo in ("ghcr.io/ikonan-ru/vps-panel", "ghcr.io/ikonan-ru/vps-panel-caddy"):
                    for ref in self.run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo]).stdout.splitlines():
                        if ref.endswith(":<none>"):
                            continue
                        items.append(dict(id="image:" + ref, title="Образ панели: " + ref, owned=True,
                                          paths=[], containers=[], blockers=[], units=[], users=[], groups=[], image=ref))
            sites = list(self.path(self.panel_root + "/sites").glob("*.caddy"))
            if sites:
                blockers.append("сначала перенести сторонние сайты из sites/*.caddy на независимый веб-сервер")
            if self.exists(self.panel_root + "/compose.override.yml"):
                blockers.append("сначала перенести дополнения из compose.override.yml; они могут зависеть от файлов панели")
        for item in items:
            for p in item["paths"]:
                try:
                    if not self.path(p).is_symlink():
                        self.safe_path(p)
                except CleanupError as e:
                    item["blockers"].append(str(e))
        # В хеш не попадают пароли и изменчивое состояние процессов, но входят ID и зависимости.
        snapshot = [{"id": c["Id"], "image": c["Image"], "name": c["Name"], "mounts": c.get("Mounts", [])}
                    for c in containers]
        result = dict(items=items, preserved=preserved, blockers=blockers, panelHost=panel)
        result["revision"] = hashlib.sha256(json.dumps([result, snapshot], sort_keys=True).encode()).hexdigest()
        return result

    def selection(self, request):
        plan = self.scan()
        if plan["revision"] != request.get("revision"):
            raise CleanupError("состав сервера изменился; обновите список очистки")
        ids = request.get("ids", [])
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            raise CleanupError("неверный список очистки")
        known = {i["id"] for i in plan["items"]}
        mandatory = {i["id"] for i in plan["items"] if i["owned"]}
        if request.get("detachOnly"):
            mandatory = {i["id"] for i in plan["items"] if i["id"] in ("agent", "portsync")}
            if set(ids) != mandatory:
                raise CleanupError("отвязка снимает только агент и зависимое управление портами")
        if not set(ids) <= known or not mandatory <= set(ids):
            raise CleanupError("список очистки не соответствует проверке сервера")
        if request.get("remote") and plan["panelHost"]:
            raise CleanupError("сервер панели очищается только командой по SSH")
        chosen = [i for i in plan["items"] if i["id"] in ids]
        errors = plan["blockers"] + [b for i in chosen for b in i["blockers"]]
        selected_containers = {c for i in chosen for c in i["containers"]}
        selected_volumes = {i["volume"] for i in chosen if "volume" in i}
        for c in self.docker():
            if c["Id"] in selected_containers:
                continue
            for m in c.get("Mounts", []):
                if m.get("Type") == "volume" and m.get("Name") in selected_volumes:
                    errors.append("сохраняемый контейнер " + c["Name"] + " использует том " + m["Name"])
                if m.get("Type") != "bind":
                    continue
                for item in chosen:
                    for p in item["paths"]:
                        source = m.get("Source", "")
                        if source == p or source.startswith(p + "/") or p.startswith(source.rstrip("/") + "/"):
                            errors.append("сохраняемый контейнер " + c["Name"] + " использует " + p)
        if errors:
            raise CleanupError("; ".join(dict.fromkeys(errors)))
        return plan, chosen

    def ssh_config(self, address="127.0.0.1"):
        out = self.run(["sshd", "-T", "-C", "user=root,host=localhost,addr=" + address]).stdout
        return dict(line.split(" ", 1) for line in out.splitlines() if " " in line)

    def rollback(self, token):
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise CleanupError("неверный идентификатор подготовки SSH")
        file = STATE_DIR + "/" + token + ".json"
        if not self.exists(file):
            return
        old = json.loads(self.text(file))
        self.write("/etc/ssh/sshd_config", old["config"], old["mode"])
        self.run(["chpasswd", "-e"], input="root:" + old["hash"] + "\n")
        self.run(["sshd", "-t"])
        self.reload_ssh()
        self.remove(file)

    def reload_ssh(self):
        for unit in ("ssh.service", "sshd.service"):
            if self.run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0:
                self.run(["systemctl", "reload", unit])
                return
        raise CleanupError("работающая служба SSH не найдена")

    def prepare(self, request):
        self.selection(request)
        password = request.get("password", "")
        if not isinstance(password, str) or not 12 <= len(password) <= 200 or any(c in password for c in "\r\n\0"):
            raise CleanupError("новый пароль root: от 12 до 200 символов без перевода строки")
        self.path(STATE_DIR).mkdir(mode=0o700, parents=True, exist_ok=True)
        if list(self.path(STATE_DIR).glob("*.json")):
            raise CleanupError("подготовка SSH уже выполняется; дождитесь её завершения или автоматического отката")
        self.run(["sshd", "-t"])
        config = self.text("/etc/ssh/sshd_config")
        shadow = next((l.split(":")[1] for l in self.text("/etc/shadow").splitlines() if l.startswith("root:")), None)
        if shadow is None:
            raise CleanupError("учётная запись root не найдена")
        token = secrets.token_hex(16)
        state = dict(config=config, mode=self.path("/etc/ssh/sshd_config").stat().st_mode & 0o777, hash=shadow,
                     revision=request["revision"], ids=request["ids"], detachOnly=bool(request.get("detachOnly")))
        self.write(STATE_DIR + "/" + token + ".json", json.dumps(state))
        try:
            # Отложенный откат переживает обрыв запроса и перезапуск панели.
            source = os.environ.get("VPS_UNINSTALL_SOURCE")
            if source is None:
                source = Path(__file__).read_text()
            self.write(STATE_DIR + "/recover.py", source, 0o700)
            self.run(["systemd-run", "--quiet", "--collect", "--unit=vps-uninstall-rollback-" + token,
                      "--on-active=5m", "python3", STATE_DIR + "/recover.py", "cancel", token])
            self.write("/etc/ssh/sshd_config", config.removesuffix(SSH_BLOCK) + SSH_BLOCK, state["mode"])
            self.run(["sshd", "-t"])
            effective = self.ssh_config()
            if effective.get("permitrootlogin") != "yes" or effective.get("passwordauthentication") != "yes" or effective.get("authenticationmethods") != "any":
                raise CleanupError("правила Match SSH запрещают вход root по паролю; сначала исправьте их вручную")
            source = os.environ.get("SSH_CONNECTION", "").split()
            if source:
                external = self.ssh_config(source[0])
                if any(external.get(k) != v for k, v in (("permitrootlogin", "yes"), ("passwordauthentication", "yes"), ("authenticationmethods", "any"))):
                    raise CleanupError("правила SSH запрещают парольный вход root с адреса текущего подключения")
            self.run(["chpasswd"], input="root:" + password + "\n")
            self.reload_ssh()
            fingerprints = []
            for pub in self.path("/etc/ssh").glob("ssh_host_*_key.pub"):
                text = self.run(["ssh-keygen", "-lf", str(pub), "-E", "sha256"]).stdout.split()
                if len(text) > 1:
                    fingerprints.append(text[1])
            if not fingerprints:
                raise CleanupError("ключи хоста SSH не найдены")
            return dict(token=token, fingerprints=fingerprints, port=int(effective.get("port", "22")))
        except Exception:
            self.rollback(token)
            raise

    def stop_units(self, units):
        for unit in sorted(units, key=lambda x: not x.endswith((".timer", ".path"))):
            if "@." in unit:
                instances = self.run(["systemctl", "list-units", "--all", "--plain", "--no-legend", unit.replace("@.", "@*." )]).stdout
                self.stop_units([line.split()[0] for line in instances.splitlines() if line.split()])
                self.run(["systemctl", "disable", unit], check=False)
                continue
            if not any(self.exists(d + unit) for d in UNIT_DIRS) and "@" not in unit:
                continue
            self.run(["systemctl", "stop", unit])
            # Статический юнит может не иметь секции Install.
            self.run(["systemctl", "disable", unit], check=False)
            if self.run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0:
                raise CleanupError("служба не остановлена: " + unit)

    def remove_key(self, public_key):
        blob = self.key_blob(public_key)
        for name in ("/root/.ssh/authorized_keys", "/root/.ssh/authorized_keys.vps-panel.bak"):
            if not self.exists(name):
                continue
            lines = self.text(name).splitlines(keepends=True)
            kept = [l for l in lines if not re.search(r"(?:^|\s)(?:ssh-\S+|ecdsa-\S+|sk-\S+)\s+" + re.escape(blob) + r"(?:\s|$)", l)]
            if name.endswith(".bak"):
                self.remove(name)
            elif lines != kept:
                self.write(name, "".join(kept))

    @staticmethod
    def key_blob(public_key):
        fields = public_key.split()
        if len(fields) < 2 or not re.fullmatch(r"[A-Za-z0-9+/=]+", fields[1]):
            raise CleanupError("не задан публичный ключ панели для удаления")
        return fields[1]

    def remove_cron(self, needle):
        current = self.run(["crontab", "-l"], check=False)
        if current.returncode not in (0, 1):
            raise CleanupError("не удалось прочитать crontab root")
        lines = current.stdout.splitlines(keepends=True)
        kept = [l for l in lines if needle not in l]
        if kept != lines:
            self.run(["crontab", "-"], input="".join(kept))

    def service_firewall(self, chosen):
        # Только правила с точными метками выбранного сервиса; SSH и чужие правила не затрагиваются.
        tags = set()
        if "wdtt" in chosen:
            tags.update(("WDTT_MANAGED", "WDTT_WG_INTERNAL"))
        for command in ("iptables", "ip6tables"):
            if not self.has(command):
                continue
            for table in ("filter", "nat", "mangle"):
                output = self.run([command, "-w", "5", "-t", table, "-S"]).stdout
                for line in output.splitlines():
                    args = shlex.split(line)
                    if "--comment" in args and args[args.index("--comment") + 1] in tags and args[0] == "-A":
                        # Установщик WDTT также помечает SSH: его доступ должен сохраниться.
                        if "--dport" in args and args[args.index("--dport") + 1] == self.ssh_config().get("port", "22"):
                            continue
                        self.run([command, "-w", "5", "-t", table, "-D", *args[1:]])
        if self.has("nft") and ("wdtt" in chosen or "mtproxyl" in chosen):
            tables = json.loads(self.run(["nft", "-j", "list", "tables"]).stdout).get("nftables", [])
            for entry in tables:
                table = entry.get("table", {})
                name, family = table.get("name", ""), table.get("family", "")
                owned = ("wdtt" in chosen and name in ("wdtt", "wdtt_mangle")) or (
                    "mtproxyl" in chosen and (name.startswith("mtproxyl_") or name == "MTProtoL"))
                if owned and family in ("ip", "ip6", "inet", "bridge"):
                    self.run(["nft", "delete", "table", family, name])

    def preserve_container_firewall(self):
        if not self.has("iptables"):
            return
        rules = self.run(["iptables", "-w", "5", "-S", "VPS-PORTSYNC"], check=False)
        if rules.returncode:
            return
        name = "/usr/local/sbin/container-firewall"
        dropin = "/etc/systemd/system/docker.service.d/50-container-firewall.conf"
        if self.exists(name) or self.exists(dropin):
            raise CleanupError("уже есть container-firewall; сначала согласуйте правила Docker вручную")
        if self.run(["iptables", "-w", "5", "-S", "CONTAINER-GUARD"], check=False).returncode == 0:
            raise CleanupError("цепочка CONTAINER-GUARD уже существует; сначала согласуйте правила вручную")
        script = "#!/bin/sh\nset -eu\niptables -w 5 -N CONTAINER-GUARD 2>/dev/null || iptables -w 5 -S CONTAINER-GUARD >/dev/null\niptables -w 5 -F CONTAINER-GUARD\n"
        for line in rules.stdout.splitlines():
            args = shlex.split(line)
            if args[:2] == ["-A", "VPS-PORTSYNC"]:
                args[1] = "CONTAINER-GUARD"
                if "--log-prefix" in args:
                    args[args.index("--log-prefix") + 1] = "[CONTAINER-GUARD DROP] "
                script += shlex.join(["iptables", "-w", "5", *args]) + "\n"
        script += "iptables -w 5 -C DOCKER-USER -j CONTAINER-GUARD 2>/dev/null || iptables -w 5 -I DOCKER-USER 1 -j CONTAINER-GUARD\n"
        self.write(name, script, 0o700)
        self.write(dropin,
                   "[Service]\nExecStartPost=/usr/local/sbin/container-firewall\n", 0o644)
        self.run([name])
        self.run(["iptables", "-w", "5", "-D", "DOCKER-USER", "-j", "VPS-PORTSYNC"])
        self.run(["iptables", "-w", "5", "-F", "VPS-PORTSYNC"])
        self.run(["iptables", "-w", "5", "-X", "VPS-PORTSYNC"])
        print("Защита контейнеров сохранена: container-firewall (статические правила)", flush=True)

    def clean_docker_resources(self, removed, chosen):
        if not self.has("docker"):
            return
        remaining = self.docker()
        images = {c["Image"] for c in removed}
        for image in images - {c["Image"] for c in remaining}:
            res = self.run(["docker", "image", "rm", image], check=False)
            if res.returncode:
                print("Общий или дополнительно помеченный образ Docker сохранён", flush=True)
        networks = []
        if "panel" in chosen:
            networks.append("vps-panel_default")
        if any(i.startswith("container:amnezia-awg2") for i in chosen):
            networks.append("amnezia-dns-net")
        for network in networks:
            found = self.run(["docker", "network", "inspect", network], check=False)
            if found.returncode == 0 and not json.loads(found.stdout)[0].get("Containers"):
                self.run(["docker", "network", "rm", network])

    def maybe_remove_docker(self, owned):
        if not owned or not self.has("docker"):
            return
        remaining = self.docker()
        images = self.run(["docker", "image", "ls", "-aq"]).stdout.strip()
        volumes = self.run(["docker", "volume", "ls", "-q"]).stdout.strip()
        networks = self.run(["docker", "network", "ls", "--filter", "type=custom", "-q"]).stdout.strip()
        if remaining or images or volumes or networks:
            print("Docker сохранён: есть сторонние или общие ресурсы", flush=True)
            return
        containerd_custom = False
        config = "/etc/containerd/config.toml"
        if self.exists(config):
            packaged = self.run(["dpkg-query", "-W", "-f=${Conffiles}", "containerd.io"], check=False).stdout
            default = re.search(r"(?:^|\n)\s*" + re.escape(config) + r"\s+([0-9a-f]{32})(?:\s|$)", packaged)
            containerd_custom = not default or hashlib.md5(self.path(config).read_bytes()).hexdigest() != default[1]
        if self.exists("/etc/docker/daemon.json") or containerd_custom:
            print("Docker сохранён: есть отдельная конфигурация движка", flush=True)
            return
        if self.exists("/var/lib/containerd") and not self.has("ctr"):
            print("Docker сохранён: нельзя проверить другие пространства containerd", flush=True)
            return
        if self.has("ctr"):
            namespaces = self.run(["ctr", "namespaces", "ls", "-q"]).stdout.split()
            if any(n != "moby" for n in namespaces):
                print("Docker сохранён: containerd используется другими приложениями", flush=True)
                return
        try:
            for directory in ("/var/lib/docker", "/var/lib/containerd"):
                self.safe_path(directory)
        except CleanupError:
            print("Docker сохранён: хранилище требует отдельной проверки точек монтирования или ссылок", flush=True)
            return
        packages = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "docker-ce-rootless-extras"]
        simulated = self.run(["apt-get", "-s", "purge", *packages], env={**os.environ, "LC_ALL": "C"}).stdout
        removed = {line.split()[1] for line in simulated.splitlines() if line.startswith(("Remv ", "Purg "))}
        if not removed <= set(packages):
            print("Docker сохранён: от него зависят другие пакеты", flush=True)
            return
        self.run(["apt-get", "purge", "-y", *packages], env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        for p in ("/var/lib/docker", "/var/lib/containerd", "/etc/apt/sources.list.d/docker.list", "/etc/apt/sources.list.d/docker.sources", "/etc/apt/keyrings/docker.asc"):
            self.remove(p)

    def execute(self, request):
        plan, items = self.selection(request)
        token = request.get("token", "")
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise CleanupError("сначала подготовьте и проверьте вход root по паролю")
        state_file = STATE_DIR + "/" + token + ".json"
        if not self.exists(state_file):
            raise CleanupError("подготовка SSH истекла; повторите проверку")
        state = json.loads(self.text(state_file))
        if state["revision"] != request["revision"] or set(state["ids"]) != set(request["ids"]):
            raise CleanupError("план не совпадает с подготовленным")
        if state.get("detachOnly", False) != bool(request.get("detachOnly")):
            raise CleanupError("режим очистки не совпадает с подготовленным")
        if not os.environ.get("SSH_CONNECTION") and not request.get("localVerified"):
            raise CleanupError("очистку нужно запустить из проверенного SSH-соединения")
        key = request.get("panelKey", "")
        if not key:
            key = self.text(self.panel_root + "/data/panel_ssh_ed25519.pub").strip()
        if not key and self.exists("/etc/vps-agent/agent.json"):
            raise CleanupError("нет публичного ключа панели; запустите очистку из интерфейса или укажите его в запросе")
        if key:
            self.key_blob(key)
        docker_owned = bool(re.search(r"(?m)^DOCKER_BY_PANEL=1$", self.text(self.panel_root + "/.env"))) or self.exists("/etc/vps-agent/docker-installed")
        before = self.docker()
        ids = set(request["ids"])
        removed = [c for c in before if any(c["Id"] in i["containers"] for i in items)]
        retained = [c for c in before if c not in removed]
        if "portsync" in ids and any(self.exists(p) for p in (
                "/usr/local/sbin/container-firewall", "/etc/systemd/system/docker.service.d/50-container-firewall.conf")):
            raise CleanupError("уже есть container-firewall; сначала согласуйте правила Docker вручную")
        if "portsync" in ids and self.has("iptables") and self.run(["iptables", "-w", "5", "-S", "CONTAINER-GUARD"], check=False).returncode == 0:
            raise CleanupError("цепочка CONTAINER-GUARD уже существует; сначала согласуйте правила вручную")
        # Проверки завершены. Откат SSH больше не нужен: пароль уже проверен отдельным входом.
        self.run(["systemctl", "stop", "vps-uninstall-rollback-" + token + ".timer"])
        self.remove(state_file)
        # Остановить автоматические изменения до снятия сервисов.
        if "portsync" in ids:
            self.stop_units(DEFINITIONS["portsync"][3])
        for item in items:
            if item["id"] not in ("agent", "portsync"):
                self.stop_units(item["units"])
                for cid in item["containers"]:
                    self.run(["docker", "rm", "-f", cid])
        for item in items:
            if item["id"] in ("panel", "agent", "portsync"):
                continue
            print("Удаление: " + item["title"], flush=True)
            if "volume" in item:
                if any(m.get("Name") == item["volume"] for c in self.docker() for m in c.get("Mounts", [])):
                    raise CleanupError("том всё ещё используется: " + item["volume"])
                self.run(["docker", "volume", "rm", item["volume"]])
            if item["id"] == "wdtt":
                if self.run(["ip", "link", "show", "wdtt0"], check=False).returncode == 0:
                    self.run(["ip", "link", "delete", "wdtt0"])
            if item["id"] == "cert-acme":
                self.remove_cron("/root/.acme.sh/acme.sh")
            if item["id"] == "cert-certbot" and self.exists("/etc/cron.d/certbot"):
                self.remove("/etc/cron.d/certbot")
            for path in item["paths"]:
                self.remove(path)
            for user in self.definitions().get(item["id"], (None, None, None, None, []))[4]:
                if self.run(["id", user], check=False).returncode == 0:
                    self.run(["userdel", user])
            for group in item["groups"]:
                entry = self.run(["getent", "group", group], check=False)
                if entry.returncode != 0:
                    continue
                fields = entry.stdout.strip().split(":")
                passwd = self.run(["getent", "passwd"]).stdout
                if len(fields) == 4 and not fields[3] and not any(l.split(":")[3] == fields[2] for l in passwd.splitlines() if len(l.split(":")) > 3):
                    self.run(["groupdel", group])
                else:
                    print("Общая группа сохранена: " + group, flush=True)
        self.service_firewall(ids)
        if "portsync" in ids and self.exists("/usr/local/sbin/vps-portsync"):
            self.run(["/usr/local/sbin/vps-portsync"])
            self.preserve_container_firewall()
        self.clean_docker_resources(removed, ids)
        for item in items:
            if "image" in item:
                if any(c.get("Config", {}).get("Image") == item["image"] for c in retained):
                    print("Образ используется сохраняемым контейнером: " + item["image"], flush=True)
                    continue
                found = self.run(["docker", "image", "inspect", item["image"]], check=False)
                if found.returncode == 0:
                    result = self.run(["docker", "image", "rm", item["image"]], check=False)
                    if result.returncode:
                        print("Общий образ Docker сохранён: " + item["image"], flush=True)
        if not request.get("detachOnly"):
            self.maybe_remove_docker(docker_owned)
        # Данные панели и агент удаляются после зависимостей: при ошибке есть материалы для восстановления.
        for kind in ("panel", "portsync"):
            for item in items:
                if item["id"] != kind:
                    continue
                print("Удаление: " + item["title"], flush=True)
                for path in item["paths"]:
                    self.remove(path)
        self.run(["systemctl", "daemon-reload"])
        if self.has("fail2ban-client"):
            self.run(["fail2ban-client", "reload"])
        if key:
            self.remove_key(key)
        for item in items:
            if item["id"] == "agent":
                print("Удаление: " + item["title"], flush=True)
                self.stop_units(item["units"])
                for path in item["paths"]:
                    self.remove(path)
        for pattern in ("/var/tmp/vps-agent.*.part*", "/usr/local/bin/.vps-agent-*"):
            for p in self.path(str(Path(pattern).parent)).glob(Path(pattern).name):
                self.remove(str(p)[len(self.root):])
        for item in items:
            if any(self.exists(p) for p in item["paths"]):
                raise CleanupError("остались файлы: " + item["title"])
        remaining_ids = {c["Id"] for c in self.docker()}
        if any(c["Id"] in remaining_ids for c in removed):
            raise CleanupError("остались выбранные контейнеры")
        print("Очистка выбранных ресурсов завершена. Вход root по новому паролю сохранён.", flush=True)
        for item in plan["items"]:
            if item["id"] not in ids:
                print("Сохранено по выбору: " + item["title"], flush=True)


@contextlib.contextmanager
def locked(engine):
    engine.path(STATE_DIR).mkdir(mode=0o700, parents=True, exist_ok=True)
    engine.path("/run/lock").mkdir(mode=0o755, parents=True, exist_ok=True)
    with engine.path("/run/lock/server-cleanup.lock").open("w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CleanupError("очистка или подготовка SSH уже выполняется") from None
        try:
            yield
        finally:
            if not list(engine.path(STATE_DIR).glob("*.json")):
                engine.remove(STATE_DIR + "/recover.py")
                engine.path(STATE_DIR).rmdir()


def interactive(engine):
    plan = engine.scan()
    if plan["blockers"]:
        raise CleanupError("; ".join(plan["blockers"]))
    with open("/dev/tty", "r+") as tty:
        def ask(message):
            tty.write(message + ": ")
            tty.flush()
            value = tty.readline()
            if not value:
                raise CleanupError("ввод прерван")
            return value.strip()
        ids = []
        for item in plan["items"]:
            print(item["title"] + "\n  " + ", ".join(item["paths"]), flush=True)
            if item["owned"] or ask("Удалить этот ресурс неизвестного происхождения? [да/нет]") == "да":
                ids.append(item["id"])
        print("Останутся: " + "; ".join(plan["preserved"]), flush=True)
        if ask("Для подтверждения введите hostname сервера (" + os.uname().nodename + ")") != os.uname().nodename:
            raise CleanupError("имя сервера не совпало")
        password = getpass.getpass("Новый пароль root: ", stream=tty)
        if password != getpass.getpass("Повторить пароль root: ", stream=tty):
            raise CleanupError("пароли не совпадают")
        request = dict(revision=plan["revision"], ids=ids, password=password)
        prepared = engine.prepare(request)
        try:
            # ASKPASS получает пароль только через окружение дочернего процесса, не argv.
            with tempfile.TemporaryDirectory(prefix="ssh-check-", dir="/run") as d:
                helper = Path(d, "askpass")
                helper.write_text("#!/usr/bin/env python3\nimport os\nprint(os.environ['ROOT_CHECK_PASSWORD'])\n")
                helper.chmod(0o700)
                known = Path(d, "known_hosts")
                lines = []
                for pub in engine.path("/etc/ssh").glob("ssh_host_*_key.pub"):
                    lines.append("[127.0.0.1]:" + str(prepared["port"]) + " " + pub.read_text())
                    lines.append("127.0.0.1 " + pub.read_text())
                known.write_text("".join(lines))
                env = {**os.environ, "SSH_ASKPASS_REQUIRE": "force", "SSH_ASKPASS": str(helper),
                       "DISPLAY": "cleanup:0", "ROOT_CHECK_PASSWORD": password}
                engine.run(["ssh", "-p", str(prepared["port"]), "-o", "StrictHostKeyChecking=yes",
                            "-o", "UserKnownHostsFile=" + str(known), "-o", "PreferredAuthentications=password",
                            "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
                            "-o", "ConnectTimeout=10", "root@127.0.0.1", "true"], env=env)
            request.pop("password")
            request.update(token=prepared["token"], localVerified=True)
            engine.execute(request)
        except Exception:
            engine.rollback(prepared["token"])
            raise


def main():
    if os.geteuid() != 0:
        raise CleanupError("запускать от root")
    engine = Engine(panel_root=os.environ.get("VPS_PANEL_ROOT", "/opt/vps-panel"))
    mode = sys.argv[1]
    if mode == "scan":
        print(json.dumps(engine.scan(), ensure_ascii=False))
        return
    with locked(engine):
        if mode == "interactive":
            interactive(engine)
        elif mode == "cancel":
            engine.rollback(sys.argv[2])
        else:
            request = json.load(sys.stdin)
            if mode == "validate":
                engine.selection(request)
                print('{"ok":true}')
            elif mode == "prepare":
                print(json.dumps(engine.prepare(request), ensure_ascii=False))
            elif mode == "run":
                engine.execute(request)
            else:
                raise CleanupError("неизвестный режим очистки")


if __name__ == "__main__":
    try:
        main()
    except (CleanupError, OSError, ValueError) as error:
        print("ОШИБКА: " + str(error), file=sys.stderr)
        sys.exit(1)
