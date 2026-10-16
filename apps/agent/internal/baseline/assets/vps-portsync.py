#!/usr/bin/env python3
"""vps-portsync: firewall, который сам следует за конфигурацией сервера.

Какие порты должны быть открыты (sshd, inbound-ы 3X-UI, MTProxyL, WireGuard и AmneziaWG,
OpenFlux, опубликованные порты docker, процессы из known_processes, extra_allow, минус
deny_public_ports), считает агент: /usr/local/bin/vps-agent -portsync-state печатает желаемое
состояние в JSON. Этот скрипт его только применяет. Нет состояния (агента нет, ошибка, мусор) -
выход с ошибкой без изменений правил: прежний firewall лучше пустого.

Правила для хоста ставятся через ufw с комментарием "vps-portsync: <сервис>" и
запоминаются в state-файле, чтобы убрать те, что больше не нужны. ufw вызывается только
для правил, которых нет в /etc/ufw/user.rules (user6.rules): каждый вызов ufw - отдельный
процесс Python, десятки вызовов на запуск заметно грузили слабые серверы.
Правила для контейнеров живут в цепочке VPS-PORTSYNC, на которую прыгает
DOCKER-USER: ufw их не видит, но docker-трафик проходит именно через них. Цепочка
пересобирается, только когда её состав поменялся.

Записи 3X-UI в базу (каждые несколько секунд) отслеживает vps-portsync-xui.path: он запускает
vps-agent -portsync-if-changed, а тот запускает эту службу, только если изменилось то, что
port-sync берёт из 3X-UI, или полный проход был больше FULL_EVERY с назад.

Запуск:  vps-portsync            применить
         vps-portsync --plan     показать, что было бы сделано
         vps-portsync --json     текущее желаемое состояние в JSON (для аудита)
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time

# корень путей - только для тестов (стенд с подменёнными файлами)
ROOT = os.environ.get("PORTSYNC_TEST_ROOT", "")
AGENT = ROOT + "/usr/local/bin/vps-agent"
# Один запуск за раз (таймер, path-юнит, docker-watch, агент): иначе правки ufw и state.json
# перемешиваются. Тот же замок берёт агент, меняя ручные правила ufw.
LOCK = ROOT + "/run/vps-portsync.lock"
STATE_DIR = ROOT + "/var/lib/vps-portsync"
STATE = STATE_DIR + "/state.json"
CHAIN = "VPS-PORTSYNC"
COMMENT = "vps-portsync"
# полный проход не реже, чем раз в столько секунд (как таймер)
FULL_EVERY = 120


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


# --------------------------------------------------------------------------
# Желаемое состояние - от агента
# --------------------------------------------------------------------------

class StateError(Exception):
    pass


def _port_list(v, name):
    if not isinstance(v, list):
        raise StateError("%s: не список" % name)
    out = []
    for p in v:
        if (not isinstance(p, list) or len(p) != 2 or p[0] not in ("tcp", "udp")
                or not isinstance(p[1], int) or isinstance(p[1], bool) or not 0 < p[1] <= 65535):
            raise StateError("%s: порт %r" % (name, p))
        out.append((p[0], p[1]))
    return out


def _str_map(v, name):
    if not isinstance(v, dict) or not all(isinstance(k, str) and isinstance(x, str) for k, x in v.items()):
        raise StateError("%s: не словарь строк" % name)
    return v


def check_state(d):
    """Состояние от агента целиком или StateError: применять половину нельзя."""
    if not isinstance(d, dict):
        raise StateError("не объект")
    ssh = d.get("ssh_port")
    if not isinstance(ssh, int) or isinstance(ssh, bool) or not 0 < ssh <= 65535:
        raise StateError("ssh_port: %r" % ssh)
    d["host_allow"] = _port_list(d.get("host_allow"), "host_allow")
    d["docker_allow"] = _port_list(d.get("docker_allow"), "docker_allow")
    d["deny"] = _port_list(d.get("deny"), "deny")
    _str_map(d.get("labels"), "labels")
    _str_map(d.get("docker_labels"), "docker_labels")
    admin = d.get("admin_ips")
    if not isinstance(admin, list) or not all(isinstance(ip, str) and ip and not ip.startswith("-") for ip in admin):
        raise StateError("admin_ips: %r" % admin)
    unknown = d.get("unknown_listeners")
    if not isinstance(unknown, list) or not all(isinstance(u, dict) and {"proto", "port", "process"} <= set(u) for u in unknown):
        raise StateError("unknown_listeners")
    findings = d.get("findings")
    if not isinstance(findings, list) or not all(isinstance(f, list) and len(f) == 2 and all(isinstance(x, str) for x in f) for f in findings):
        raise StateError("findings")
    wan = d.get("wan_interface")
    if not isinstance(wan, str) or not re.fullmatch(r"[A-Za-z0-9._@-]{1,32}", wan) or wan.startswith("-"):
        raise StateError("wan_interface: %r" % wan)
    if d.get("xui_fp") is not None and not isinstance(d.get("xui_fp"), str):
        raise StateError("xui_fp")
    return d


def agent_state():
    """Желаемое состояние от агента (vps-agent -portsync-state)."""
    try:
        p = subprocess.run([AGENT, "-portsync-state"], capture_output=True, text=True, timeout=150)
    except (OSError, subprocess.SubprocessError) as e:
        raise StateError("%s -portsync-state: %s" % (AGENT, e))
    if p.returncode != 0:
        raise StateError("%s -portsync-state: код %d: %s" % (AGENT, p.returncode, (p.stderr or p.stdout).strip()[:500]))
    try:
        d = json.loads(p.stdout)
    except ValueError as e:
        raise StateError("%s -portsync-state: не JSON: %s" % (AGENT, e))
    return check_state(d)


def xui_unchanged(desired):
    """Запуск прямо от vps-portsync-xui.path (path-юнит с Unit=vps-portsync.service, пока агент
    не поставил свой): 3X-UI не поменялся в том, что берёт port-sync, и полный проход был недавно."""
    state = load_state()
    prev = state.get("xui_fp")
    fresh = 0 <= time.time() - float(state.get("full_at") or 0) < FULL_EVERY
    return fresh and bool(prev) and prev == desired.get("xui_fp")


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


UFW_RULES = ((ROOT + "/etc/ufw/user.rules", False), (ROOT + "/etc/ufw/user6.rules", True))


def ufw_present():
    """Правила, которые уже стоят в ufw: строки "### tuple ###" из user.rules и user6.rules -
    {(v6, (действие, протокол, порт, куда, порт источника, откуда, направление, comment=hex))}."""
    present = set()
    for path, v6 in UFW_RULES:
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        for line in lines:
            if line.startswith("### tuple ### "):
                present.add((v6, tuple(line[len("### tuple ### "):].split())))
    return present


def ufw_ipv6():
    try:
        with open(ROOT + "/etc/default/ufw") as f:
            return re.search(r'^IPV6=\s*"?yes', f.read(), re.M) is not None
    except OSError:
        return False


def ufw_tuples(rule, ipv6):
    """Как ufw запишет правило ufw_rule_args в user.rules (user6.rules); [] - не знаем
    (тогда ufw вызывается, как раньше)."""
    try:
        src = rule[rule.index("from") + 1]
        port = rule[rule.index("port") + 1]
        proto = rule[rule.index("proto") + 1]
    except (ValueError, IndexError):
        return []
    tail = ("in",)
    if "comment" in rule:
        tail += ("comment=" + rule[rule.index("comment") + 1].encode("utf-8").hex(),)
    v4 = (rule[0], proto, port, "0.0.0.0/0", "any")
    v6 = (rule[0], proto, port, "::/0", "any")
    if src == "any":
        res = [(False, v4 + ("0.0.0.0/0",) + tail)]
        if ipv6:
            res.append((True, v6 + ("::/0",) + tail))
        return res
    if ":" in src:
        return [(True, v6 + (src,) + tail)] if ipv6 else []
    return [(False, v4 + (src,) + tail)]


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
        # обновляет комментарий; правило, что уже стоит с тем же комментарием, не трогаем
        present, ipv6 = ufw_present(), ufw_ipv6()
        same = 0
        for rule in wanted:
            tuples = ufw_tuples(rule, ipv6)
            if tuples and all(t in present for t in tuples):
                same += 1
                continue
            run(["ufw"] + rule)
        log("ufw: уже стоят %d из %d правил" % (same, len(wanted)))
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
    # тот же состав, что при прошлой сборке, и в цепочке столько же правил - не пересобирать
    # (сброс и сборка - по вызову iptables на правило, и пока цепочка пуста, она пропускает всё)
    rc, cur = run(["iptables", "-w", "5", "-S", CHAIN])
    state = load_state()
    built = [wan] + [list(r) for r in rules]
    count = sum(1 for line in cur.splitlines() if line.startswith("-A "))
    if rc == 0 and state.get("docker_chain") == built and count == len(rules):
        log("%s: без изменений" % CHAIN)
    else:
        if rc != 0:
            ipt(["-N", CHAIN], plan, log)
        ipt(["-F", CHAIN], plan, log)
        for r in rules:
            rc, _ = ipt(["-A", CHAIN] + r, plan, log)
            if rc != 0 and "comment" in r:
                # нет модуля xt_comment - правило без подписи, порт контейнера важнее подписи
                i = r.index("-m", r.index("--ctorigdstport"))
                ipt(["-A", CHAIN] + r[:i] + r[i + 4:], plan, log)
        if not plan:
            state["docker_chain"] = built
            save_state(state)
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
    try:
        desired = agent_state()
    except StateError as e:
        print("vps-portsync: нет желаемого состояния, правила не менялись: %s" % e, file=sys.stderr)
        return 1
    if (os.environ.get("TRIGGER_UNIT") == "vps-portsync-xui.path" and not args.plan
            and not args.json and xui_unchanged(desired)):
        return 0
    wan = desired["wan_interface"]

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
        state = load_state()
        state["xui_fp"] = desired.get("xui_fp") or None
        state["full_at"] = time.time()
        save_state(state)
        os.makedirs(STATE_DIR, exist_ok=True)
        # 0600: в отчёте путь панели 3X-UI (webBasePath)
        fd = os.open(STATE_DIR + "/last.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(desired, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
