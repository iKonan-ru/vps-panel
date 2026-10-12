#!/usr/bin/env python3
"""vps-portsync: firewall, который сам следует за конфигурацией сервера.

Источники правды о том, какие порты должны быть открыты:
  * порт sshd (из sshd -T)
  * inbound-ы 3x-ui из /etc/x-ui/x-ui.db (или из тома docker-контейнера панели)
  * порт подписок 3x-ui (subPort), если подписки включены
  * MTProxyL: порт прокси из config.toml или mtproxyl status --json
  * WireGuard / AmneziaWG в ядре: wg show all listen-port, awg show
  * опубликованные порты docker-контейнеров (Amnezia и прочие) - в цепочку DOCKER-USER
  * порты процессов из known_processes (wdtt-server, telemt, mtproxyl-panel...) по ss
  * ручной список extra_allow из конфига

Что закрывается:
  * панель 3x-ui (webPort) открыта, как и остальные inbound-ы: она защищена
    HTTPS и длинным webBasePath; закрыть её можно через deny_public_ports
  * deny_public_ports - никогда снаружи
  * всё остальное - политика ufw по умолчанию (deny)

Правила для хоста ставятся через ufw с комментарием "vps-portsync: <сервис>" и
запоминаются в state-файле, чтобы убрать те, что больше не нужны.
Правила для контейнеров живут в цепочке VPS-PORTSYNC, на которую прыгает
DOCKER-USER: ufw их не видит, но docker-трафик проходит именно через них.

Запуск:  vps-portsync            применить
         vps-portsync --plan     показать, что было бы сделано
         vps-portsync --json     текущее желаемое состояние в JSON (для аудита)
"""
import argparse
import fcntl
import fnmatch
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys

CONF = "/etc/vps-portsync.conf"
# Один запуск за раз (таймер, path-юнит, docker-watch, агент): иначе правки ufw и state.json
# перемешиваются. Тот же замок берёт агент, меняя ручные правила ufw.
LOCK = "/run/vps-portsync.lock"
STATE = "/var/lib/vps-portsync/state.json"
CHAIN = "VPS-PORTSYNC"
COMMENT = "vps-portsync"


def label_text(s, limit=40):
    """Подпись сервиса для комментария ufw: буквы (и кириллица), цифры, пробел и - _ . : /,
    без кавычек и эмодзи (флаги в имени inbound-а 3X-UI), не длиннее limit."""
    s = re.sub(r"[^\w .:/-]+", " ", s or "", flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit].strip()


def rule_comment(label):
    """vps-portsync: <сервис> - по префиксу port-sync узнаёт свои правила, подпись видна в
    ufw status и в панели: какой порт от какого сервиса."""
    label = label_text(label)
    return "%s: %s" % (COMMENT, label) if label else COMMENT

UDP_PROTOCOLS = {"wireguard", "amneziawg", "hysteria", "tuic"}
UDP_NETWORKS = {"kcp", "quic", "mkcp"}
BOTH_PROTOCOLS = {"shadowsocks", "mixed"}


def run(cmd, check=False, quiet=True):
    """Запустить команду, вернуть (код, stdout)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        if check:
            raise
        return 1, "" if quiet else str(e)
    if check and p.returncode != 0:
        raise RuntimeError("%s -> %s %s" % (" ".join(cmd), p.stdout, p.stderr))
    return p.returncode, p.stdout


def load_conf():
    conf = {
        "admin_ips": [],
        "deny_public_ports": [],
        "extra_allow": [],
        "known_processes": ["sshd"],
        "docker_policy": "published",
        "allow_ping": True,
        "wan_interface": "",
        "ssh_port": 0,
    }
    if os.environ.get("PORTSYNC_CONF"):
        conf.update(json.loads(os.environ["PORTSYNC_CONF"]))
    elif os.path.exists(CONF):
        with open(CONF) as f:
            conf.update(json.load(f))
    return conf


def parse_port(spec):
    """'443/tcp' -> ('tcp', 443). Без протокола - tcp."""
    spec = str(spec).strip()
    if "/" in spec:
        port, proto = spec.split("/", 1)
    else:
        port, proto = spec, "tcp"
    return proto.lower(), int(port)


def wan_interface(conf):
    if conf.get("wan_interface"):
        return conf["wan_interface"]
    rc, out = run(["ip", "-o", "route", "get", "1.1.1.1"])
    m = re.search(r"\bdev\s+(\S+)", out)
    return m.group(1) if m else "eth0"


# --------------------------------------------------------------------------
# Обнаружение портов
# --------------------------------------------------------------------------

def ssh_port(conf):
    if conf.get("ssh_port"):
        return int(conf["ssh_port"])
    rc, out = run(["sshd", "-T"])
    m = re.search(r"^port\s+(\d+)", out, re.M)
    return int(m.group(1)) if m else 22


def find_xui_db():
    """Путь к базе 3x-ui: нативная установка или том docker-контейнера."""
    if os.environ.get("XUI_DB"):
        return os.environ["XUI_DB"]
    if os.path.exists("/etc/x-ui/x-ui.db"):
        return "/etc/x-ui/x-ui.db"
    if shutil.which("docker"):
        rc, out = run(["docker", "ps", "-q"])
        for cid in out.split():
            rc, mounts = run(["docker", "inspect", "-f",
                              "{{range .Mounts}}{{.Source}}|{{.Destination}}\n{{end}}", cid])
            for line in mounts.splitlines():
                if "|" not in line:
                    continue
                src, dst = line.split("|", 1)
                if dst.rstrip("/") == "/etc/x-ui":
                    cand = os.path.join(src, "x-ui.db")
                    if os.path.exists(cand):
                        return cand
    return None


def xui_pg_dsn():
    """DSN PostgreSQL из /etc/default/x-ui, если 3x-ui настроен на него (XUI_DB_TYPE=postgres)."""
    try:
        with open("/etc/default/x-ui") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    env = {}
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("\"'")
    if env.get("XUI_DB_TYPE", "").lower() == "postgres" and env.get("XUI_DB_DSN"):
        return env["XUI_DB_DSN"]
    return None


def xui_pg_query(dsn, query):
    """Запрос к PostgreSQL через psql; пароль уходит в окружении, не в аргументах."""
    from urllib.parse import urlparse, parse_qs
    u = urlparse(dsn)
    env = dict(os.environ)
    env["PGHOST"] = u.hostname or "127.0.0.1"
    env["PGDATABASE"] = (u.path or "/").lstrip("/")
    if u.port:
        env["PGPORT"] = str(u.port)
    if u.username:
        env["PGUSER"] = u.username
    if u.password:
        env["PGPASSWORD"] = u.password
    mode = parse_qs(u.query).get("sslmode")
    if mode:
        env["PGSSLMODE"] = mode[0]
    p = subprocess.run(["psql", "-At", "-F", "\x1f", "-R", "\x1e", "-c", query],
                       env=env, capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    rows = []
    for rec in p.stdout.split("\x1e"):
        if rec.strip():
            rows.append(rec.split("\x1f"))
    return rows


def xui_ports(findings):
    """Возвращает (public: set[(proto,port)], panel: set[(proto,port)], info)."""
    public, panel, info = set(), set(), {}
    dsn = xui_pg_dsn()
    if dsn:
        info["db"] = "postgres"
        if not shutil.which("psql"):
            findings.append(("high", "3x-ui хранит данные в PostgreSQL, а psql не установлен: порты inbound не открыты"))
            return public, panel, info
        try:
            settings = {r[0].strip(): r[1].strip() for r in xui_pg_query(dsn, "select key, value from settings") if len(r) == 2}
            has_node = xui_pg_query(dsn, "select count(*) from information_schema.columns where table_name='inbounds' and column_name='node_id'")
            node_col = "coalesce(node_id,0)" if has_node and has_node[0][0].strip() != "0" else "0"
            raw = xui_pg_query(dsn, "select port, protocol, coalesce(listen,''), enable, coalesce(stream_settings,''), coalesce(remark,''), %s from inbounds" % node_col)
            rows = []
            for r in raw:
                if len(r) != 7:
                    continue
                rows.append((int(r[0].strip() or 0), r[1].strip(), r[2].strip(),
                             r[3].strip() in ("t", "true", "1"), r[4], r[5].strip(), int(r[6].strip() or 0)))
        except (RuntimeError, subprocess.SubprocessError, ValueError) as e:
            findings.append(("high", "3x-ui: не удалось прочитать PostgreSQL: %s" % e))
            return public, panel, info
    else:
        db = find_xui_db()
        if not db:
            return public, panel, info
        info["db"] = db
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
            cur = con.cursor()
            settings = dict(cur.execute("select key, value from settings").fetchall())
            # node_id есть в 3x-ui с групповым управлением: inbound чужого узла здесь не слушает
            has_node = cur.execute("select count(*) from pragma_table_info('inbounds') where name='node_id'").fetchone()[0]
            node_col = "coalesce(node_id,0)" if has_node else "0"
            rows = cur.execute(
                "select port, protocol, listen, enable, stream_settings, remark, %s from inbounds" % node_col
            ).fetchall()
            con.close()
        except sqlite3.Error as e:
            findings.append(("high", "3x-ui: не удалось прочитать %s: %s" % (db, e)))
            return public, panel, info

    web_port = int(settings.get("webPort") or 2053)
    web_listen = settings.get("webListen") or ""
    info["panel_port"] = web_port
    info["panel_listen"] = web_listen or "0.0.0.0"
    info["panel_https"] = bool(settings.get("webCertFile")) and bool(settings.get("webKeyFile"))
    info["panel_base_path"] = settings.get("webBasePath") or "/"
    info["panel_2fa"] = str(settings.get("twoFactorEnable", "false")).lower() == "true"
    # панель на 127.0.0.1 (новая схема, вход через VPS Panel) - порт снаружи не нужен
    labels = info.setdefault("labels", {})
    if web_listen in ("", "0.0.0.0", "::"):
        panel.add(("tcp", web_port))
        labels[("tcp", web_port)] = "3X-UI панель"

    if str(settings.get("subEnable", "false")).lower() == "true":
        sub_port = int(settings.get("subPort") or 2096)
        sub_listen = settings.get("subListen") or ""
        info["sub_port"] = sub_port
        if sub_listen in ("", "0.0.0.0", "::"):
            public.add(("tcp", sub_port))
            labels[("tcp", sub_port)] = "3X-UI подписки"

    inbounds = []
    for port, protocol, listen, enable, stream, remark, node_id in rows:
        if not enable or not port or node_id:
            continue
        if listen and listen not in ("0.0.0.0", "::", ""):
            # слушает localhost или конкретный внутренний адрес - снаружи не нужен
            if listen.startswith("127.") or listen == "::1":
                continue
        network = ""
        try:
            network = (json.loads(stream or "{}").get("network") or "").lower()
        except ValueError:
            pass
        protos = set()
        if protocol in UDP_PROTOCOLS or network in UDP_NETWORKS:
            protos.add("udp")
        elif protocol in BOTH_PROTOCOLS:
            protos.update({"tcp", "udp"})
        else:
            protos.add("tcp")
        if protocol == "dokodemo-door":
            continue
        for pr in protos:
            public.add((pr, int(port)))
            labels[(pr, int(port))] = "3X-UI " + (label_text(remark, 28) or protocol)
        inbounds.append({"port": port, "protocol": protocol, "network": network, "remark": remark})
    info["inbounds"] = inbounds
    return public, panel, info


def mtproxy_ports(findings):
    """Порт MTProxyL: status --json, затем config.toml, затем ничего."""
    ports = set()
    info = {}
    for path in ("/opt/mtproxyl/mtproxy/config.toml", "/opt/mtproxyl/mtproxy/telemt.toml"):
        if os.path.exists(path):
            with open(path) as f:
                text = f.read()
            m = re.search(r'^\s*port\s*=\s*(\d+)', text, re.M)
            if m:
                ports.add(("tcp", int(m.group(1))))
                info["config"] = path
                break
    if not ports and shutil.which("mtproxyl"):
        rc, out = run(["mtproxyl", "status", "--json"])
        if rc == 0 and out.strip():
            try:
                data = json.loads(out)
                for key in ("port", "proxy_port", "PROXY_PORT"):
                    v = _dig(data, key)
                    if v:
                        ports.add(("tcp", int(v)))
                        info["source"] = "mtproxyl status --json"
                        break
            except (ValueError, TypeError):
                pass
    if ports:
        info["ports"] = sorted(p for _, p in ports)
    return ports, info


def _dig(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = _dig(v, key)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _dig(v, key)
            if r:
                return r
    return None


def wireguard_ports(labels):
    """Ядерные WireGuard/AmneziaWG интерфейсы на хосте (не в контейнерах)."""
    ports = set()
    for tool in ("wg", "awg"):
        if not shutil.which(tool):
            continue
        rc, out = run([tool, "show", "all", "listen-port"])
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].isdigit():
                ports.add(("udp", int(parts[1])))
                # wdtt0 - встроенный WireGuard сервера WDTT
                name = "WDTT" if parts[0].startswith("wdtt") else "WireGuard " + parts[0]
                labels.setdefault(("udp", int(parts[1])), name)
            elif len(parts) == 1 and parts[0].isdigit():
                ports.add(("udp", int(parts[0])))
                labels.setdefault(("udp", int(parts[0])), "WireGuard")
    return ports


def wdtt_internal_ports():
    """WireGuard сервера WDTT (-wg-port в юните wdtt.service): только внутри сервера - снаружи
    к нему ходят через DTLS-порт, а deploy.sh режет его своим правилом. wdtt-server слушает его
    на 0.0.0.0, и без исключения порт открывался бы в ufw, как прочие порты процесса."""
    ports = set()
    for path in ("/etc/systemd/system/wdtt.service", "/lib/systemd/system/wdtt.service",
                 "/usr/lib/systemd/system/wdtt.service"):
        try:
            with open(path) as f:
                text = f.read()
        except OSError:
            continue
        for m in re.finditer(r"-wg-port[ =](\d+)", text):
            ports.add(("udp", int(m.group(1))))
    return ports


def openflux_ports(labels):
    """Каналы OpenFlux (node-install.sh): /etc/openflux-node/<канал>/port, TCP. Порт открыт
    и тогда, когда процесс упал: канал установлен, клиенты придут, как только он поднимется."""
    ports = set()
    for path in glob.glob("/etc/openflux-node/*/port"):
        try:
            with open(path) as f:
                port = int(f.read().strip())
        except (OSError, ValueError):
            continue
        if 0 < port < 65536:
            ports.add(("tcp", port))
            labels.setdefault(("tcp", port), "OpenFlux " + os.path.basename(os.path.dirname(path)))
    return ports


def listening_public():
    """Слушающие наружу сокеты: [(proto, port, process)]."""
    rc, out = run(["ss", "-tulnpH"])
    res = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        m = re.match(r"^(.*):(\d+)$", parts[4])
        if not m:
            continue
        addr, port = m.group(1), int(m.group(2))
        if addr.startswith("127.") or addr in ("[::1]", "::1") or addr.startswith("[::ffff:127."):
            continue
        pm = re.search(r'users:\(\("([^"]+)"', line)
        proc = pm.group(1) if pm else ""
        item = (parts[0], port, proc)
        if item not in res:
            res.append(item)
    return res


# имя процесса -> сервис в подписи правила
PROCESS_LABELS = [
    ("sshd", "SSH"), ("xray*", "3X-UI"), ("x-ui", "3X-UI"), ("telemt", "MTProxyL"),
    ("mtproxyl*", "MTProxyL"), ("wdtt*", "WDTT"), ("openflux*", "OpenFlux"), ("caddy", "Caddy"),
    ("vps-agent", "VPS Panel агент"),
]


def process_label(proc):
    for pat, name in PROCESS_LABELS:
        if fnmatch.fnmatch(proc, pat):
            return name
    return proc


def process_ports(known, listeners, labels):
    """Порты процессов из белого списка и список чужих слушателей."""
    allowed, unknown = set(), []
    for proto, port, proc in listeners:
        if proto == "udp" and port in (68, 546):
            continue
        if proc == "docker-proxy":
            continue  # опубликованные порты контейнеров обрабатываются отдельно
        if any(fnmatch.fnmatch(proc, pat) for pat in known):
            allowed.add((proto, port))
            labels.setdefault((proto, port), process_label(proc))
        else:
            unknown.append({"proto": proto, "port": port, "process": proc})
    return allowed, unknown


def docker_published():
    """Опубликованные порты контейнеров с bridge-сетью: список dict."""
    result = []
    if not shutil.which("docker"):
        return result
    rc, out = run(["docker", "ps", "-q"])
    if rc != 0:
        return result
    for cid in out.split():
        rc, js = run(["docker", "inspect", cid])
        try:
            data = json.loads(js)[0]
        except (ValueError, IndexError):
            continue
        name = data.get("Name", "").lstrip("/")
        netmode = data.get("HostConfig", {}).get("NetworkMode", "")
        bindings = data.get("HostConfig", {}).get("PortBindings") or {}
        for cport, binds in bindings.items():
            proto = cport.split("/")[1] if "/" in cport else "tcp"
            for b in binds or []:
                hp = b.get("HostPort")
                hip = b.get("HostIp") or ""
                if not hp:
                    continue
                if hip.startswith("127.") or hip == "::1":
                    continue
                result.append({"container": name, "proto": proto, "port": int(hp),
                               "host_ip": hip, "network_mode": netmode})
    return result


def host_network_containers():
    names = []
    if not shutil.which("docker"):
        return names
    rc, out = run(["docker", "ps", "--format", "{{.Names}}|{{.Image}}"])
    for line in out.splitlines():
        if "|" in line:
            name, image = line.split("|", 1)
            rc, mode = run(["docker", "inspect", "-f", "{{.HostConfig.NetworkMode}}", name])
            if mode.strip() == "host":
                names.append(name)
    return names


# --------------------------------------------------------------------------
# Желаемое состояние
# --------------------------------------------------------------------------

def desired_state(conf):
    findings = []
    deny = {parse_port(p) for p in conf.get("deny_public_ports", [])}
    extra = {parse_port(p) for p in conf.get("extra_allow", [])}
    sshp = ssh_port(conf)

    xui_public, xui_panel, xui_info = xui_ports(findings)
    mt_ports, mt_info = mtproxy_ports(findings)
    # подписи правил: (proto, port) -> сервис; первая подпись побеждает (3X-UI и MTProxyL
    # точнее, чем имя процесса)
    labels = {("tcp", sshp): "SSH"}
    for k, v in xui_info.pop("labels", {}).items():
        labels.setdefault(k, v)
    for k in mt_ports:
        labels.setdefault(k, "MTProxyL")
    wg = wireguard_ports(labels)
    of = openflux_ports(labels)
    published = docker_published()
    listeners = listening_public()
    proc_ports, unknown = process_ports(conf.get("known_processes", []), listeners, labels)
    proc_ports -= wdtt_internal_ports()
    for k in extra:
        labels.setdefault(k, "вручную (extra_allow)")

    host_allow = {("tcp", sshp)} | xui_public | xui_panel | mt_ports | wg | of | proc_ports | extra
    host_allow -= deny
    unknown = [u for u in unknown if (u["proto"], u["port"]) not in host_allow]

    docker_allow = set()
    docker_labels = {}
    if conf.get("docker_policy", "published") == "published":
        for p in published:
            key = (p["proto"], p["port"])
            if key in deny:
                continue
            docker_allow.add(key)
            docker_labels.setdefault(key, p["container"])
    for k in extra:
        docker_labels.setdefault(k, "вручную (extra_allow)")
    docker_allow |= extra
    docker_allow -= deny

    if xui_panel:
        if not xui_info.get("panel_https"):
            findings.append(("high", "3x-ui: панель открыта в интернет БЕЗ HTTPS (webCertFile пуст)"))
        if xui_info.get("panel_base_path", "/") in ("/", ""):
            findings.append(("medium", "3x-ui: панель открыта в интернет с webBasePath '/', нужен длинный путь"))
        if not xui_info.get("panel_2fa"):
            findings.append(("info", "3x-ui: 2FA в панели выключена (Settings -> Security)"))

    return {
        "ssh_port": sshp,
        "host_allow": sorted(host_allow),
        "docker_allow": sorted(docker_allow),
        # JSON не умеет кортежи в ключах: "443/tcp" -> сервис
        "labels": {"%s/%s" % (p, pr): v for (pr, p), v in labels.items() if (pr, p) in host_allow},
        "docker_labels": {"%s/%s" % (p, pr): v for (pr, p), v in docker_labels.items() if (pr, p) in docker_allow},
        "docker_published": published,
        "host_network_containers": host_network_containers(),
        "deny": sorted(deny),
        "unknown_listeners": unknown,
        "admin_ips": conf.get("admin_ips", []),
        "allow_ping": bool(conf.get("allow_ping", True)),
        "xui": xui_info,
        "mtproxy": mt_info,
        "wireguard_ports": sorted(p for _, p in wg),
        "findings": findings,
    }


# --------------------------------------------------------------------------
# Применение: ufw (хост)
# --------------------------------------------------------------------------

def ufw_rule_args(proto, port, src=None, label=""):
    args = ["allow"]
    if src:
        args += ["from", src]
    else:
        args += ["from", "any"]
    args += ["to", "any", "port", str(port), "proto", proto, "comment", rule_comment(label)]
    return args


def rule_base(rule):
    """Правило без комментария: ufw считает правила с разным комментарием одним и тем же."""
    rule = list(rule)
    if "comment" in rule:
        rule = rule[:rule.index("comment")]
    return tuple(rule)


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"ufw_rules": []}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE)


def apply_ufw(desired, plan, log):
    labels = desired.get("labels", {})
    wanted = []
    for proto, port in desired["host_allow"]:
        wanted.append(ufw_rule_args(proto, port, label=labels.get("%s/%s" % (port, proto), "")))
    # SSH ещё и с admin_ips явно, на случай если кто-то удалит общее правило
    for ip in desired["admin_ips"]:
        wanted.append(ufw_rule_args("tcp", desired["ssh_port"], ip, "SSH admin"))

    state = load_state()
    current = [list(r) for r in state.get("ufw_rules", [])]
    # Сравнение - без комментария. ufw: то же правило с другим комментарием - "Rule updated"
    # на месте, без разрыва; delete срабатывает только с точным текущим комментарием (или
    # совсем без него). Поэтому смена подписи - повторный allow, а delete - только для порта,
    # который больше не нужен, и с тем комментарием, с которым правило ставили.
    wanted_bases = {rule_base(r) for r in wanted}
    for rule in current:
        if rule_base(rule) in wanted_bases:
            continue
        log("ufw delete %s" % " ".join(rule))
        if not plan:
            run(["ufw", "delete"] + list(rule))
    current_set = {tuple(r) for r in current}
    for rule in wanted:
        if tuple(rule) not in current_set:
            log("ufw %s" % " ".join(rule))
    if not plan:
        # allow идемпотентен: существующее правило ufw пропускает, с другим комментарием -
        # обновляет комментарий
        for rule in wanted:
            run(["ufw"] + rule)
        state["ufw_rules"] = [list(r) for r in wanted]
        save_state(state)


# --------------------------------------------------------------------------
# Применение: DOCKER-USER (контейнеры)
# --------------------------------------------------------------------------

def ipt(args, plan, log):
    log("iptables %s" % " ".join(args))
    if not plan:
        return run(["iptables", "-w", "5"] + args)
    return 0, ""


def apply_docker_chain(desired, wan, plan, log):
    rc, _ = run(["iptables", "-w", "5", "-nL", "DOCKER-USER"])
    if rc != 0:
        log("DOCKER-USER отсутствует (docker не запущен?) - пропускаю цепочку контейнеров")
        return
    rc, _ = run(["iptables", "-w", "5", "-nL", CHAIN])
    if rc != 0:
        ipt(["-N", CHAIN], plan, log)
    ipt(["-F", CHAIN], plan, log)
    rules = [
        ["!", "-i", wan, "-j", "RETURN"],
        ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "RETURN"],
    ]
    dl = desired.get("docker_labels", {})
    for proto, port in desired["docker_allow"]:
        rule = ["-p", proto, "-m", "conntrack", "--ctdir", "ORIGINAL",
                "--ctorigdstport", str(port)]
        label = label_text(dl.get("%s/%s" % (port, proto), ""), 64)
        if label:
            # какой контейнер: видно в iptables -L DOCKER-USER (цепочка VPS-PORTSYNC)
            rule += ["-m", "comment", "--comment", label]
        rules.append(rule + ["-j", "RETURN"])
    rules.append(["-m", "limit", "--limit", "3/min", "--limit-burst", "10",
                  "-j", "LOG", "--log-prefix", "[VPS-PORTSYNC DROP] "])
    rules.append(["-j", "DROP"])
    for r in rules:
        rc, _ = ipt(["-A", CHAIN] + r, plan, log)
        if rc != 0 and "comment" in r:
            # нет модуля xt_comment - правило без подписи, порт контейнера важнее подписи
            i = r.index("-m", r.index("--ctorigdstport"))
            ipt(["-A", CHAIN] + r[:i] + r[i + 4:], plan, log)
    rc, _ = run(["iptables", "-w", "5", "-C", "DOCKER-USER", "-j", CHAIN])
    if rc != 0:
        ipt(["-I", "DOCKER-USER", "1", "-j", CHAIN], plan, log)


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true", help="только показать действия")
    ap.add_argument("--json", action="store_true", help="желаемое состояние в JSON")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if os.geteuid() != 0 and not args.json:
        print("нужен root", file=sys.stderr)
        return 2

    conf = load_conf()
    desired = desired_state(conf)
    wan = wan_interface(conf)
    desired["wan_interface"] = wan

    if args.json:
        print(json.dumps(desired, indent=2, ensure_ascii=False))
        return 0

    lock = open(LOCK, "w")
    fcntl.flock(lock, fcntl.LOCK_EX)

    lines = []

    def log(msg):
        lines.append(msg)
        if args.plan or args.verbose:
            print(msg)

    log("ssh: %s  wan: %s" % (desired["ssh_port"], wan))
    log("host allow: %s" % ", ".join("%s/%s" % (p, pr) for pr, p in desired["host_allow"]))
    log("docker allow: %s" % ", ".join("%s/%s" % (p, pr) for pr, p in desired["docker_allow"]))
    for u in desired["unknown_listeners"]:
        log("закрыто (процесс не в known_processes): %s/%s %s" % (u["port"], u["proto"], u["process"]))
    for sev, msg in desired["findings"]:
        log("[%s] %s" % (sev, msg))

    apply_ufw(desired, args.plan, log)
    apply_docker_chain(desired, wan, args.plan, log)
    if not args.plan:
        os.makedirs("/var/lib/vps-portsync", exist_ok=True)
        # 0600: в отчёте путь панели 3X-UI (webBasePath)
        fd = os.open("/var/lib/vps-portsync/last.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(desired, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
