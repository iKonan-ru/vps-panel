"""Смена порта SSH с независимым откатом до проверки нового входа панелью."""
import fcntl
import glob
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys

STATE = Path('/etc/vps-agent/ssh-port')
CONFIG = '/etc/ssh/sshd_config'
FAIL2BAN = Path('/etc/fail2ban')
PORTSYNC = Path('/etc/vps-portsync.conf')
SYSTEMD = Path('/etc/systemd/system')


def run(args, check=True):
    p = subprocess.run(args, text=True, capture_output=True, timeout=40)
    if check and p.returncode:
        raise RuntimeError(' '.join(args[:2]) + ': ' + p.stderr.strip())
    return p


def write(path, text, mode=0o600):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_name(p.name + '.vps-tmp')
    with temp.open('w') as file:
        os.fchmod(file.fileno(), mode)
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    temp.replace(p)
    fd = os.open(p.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ports():
    return sorted({int(line.split()[1]) for line in run(['sshd', '-T']).stdout.splitlines()
                   if line.startswith('port ')})


def free(port):
    # Проверить TCP и UDP, IPv4 и IPv6, включая слушателей только на конкретном адресе.
    sockets = []
    try:
        for family, address in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
            if family == socket.AF_INET6 and not socket.has_ipv6:
                continue
            for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
                s = socket.socket(family, kind)
                sockets.append(s)
                if family == socket.AF_INET6:
                    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                s.bind((address, port))
        return True
    except OSError:
        return False
    finally:
        for s in sockets:
            s.close()


def validate_port(port):
    if type(port) is not int or not (1024 <= port <= 65535 or port == 22):
        raise ValueError('порт SSH: 1024-65535 (или 22 для возврата стандартного порта)')
    return port


def reserved_ports():
    agent = Path('/usr/local/bin/vps-agent')
    if not agent.exists():
        return set()
    state = json.loads(run([str(agent), '-portsync-state']).stdout)
    result = {p[1] for key in ('host_allow', 'docker_allow', 'deny') for p in (state.get(key) or [])}
    result.update(p['port'] for p in (state.get('docker_published') or []))
    return result


def choose():
    reserved = reserved_ports()
    for _ in range(200):
        port = secrets.randbelow(65536 - 1024) + 1024
        if port not in reserved and free(port):
            return port
    raise RuntimeError('свободный порт не найден')


def config_files(path=None, files=None):
    path = path or CONFIG
    files = {} if files is None else files
    path = str(Path(path).resolve())
    if path in files:
        return files
    p = Path(path)
    files[path] = dict(text=p.read_text(), mode=p.stat().st_mode & 0o777)
    for line in files[path]['text'].splitlines():
        words = shlex.split(line, comments=True)
        if not words:
            continue
        key = words[0].lower()
        if key == 'include':
            for pattern in words[1:]:
                for child in sorted(glob.glob(pattern if pattern.startswith('/') else '/etc/ssh/' + pattern)):
                    config_files(child, files)
        if key == 'listenaddress' and len(words) > 1:
            address = words[1]
            if re.search(r'\]:\d+$', address) or address.count(':') == 1:
                raise RuntimeError('ListenAddress содержит порт; уберите порт из ListenAddress и повторите смену')
    return files


def active(unit):
    return run(['systemctl', 'is-active', '--quiet', unit], False).returncode == 0


def reload_ssh(state):
    run(['sshd', '-t'])
    if state['socket']:
        run(['systemctl', 'daemon-reload'])
        # KillMode=process проверен до изменений: открытые SSH-сессии сохраняются.
        run(['systemctl', 'stop', state['service']])
        run(['systemctl', 'restart', state['socket']])
        run(['systemctl', 'start', state['service']])
    else:
        run(['systemctl', 'reload', state['service']])


def save(state):
    write(STATE / 'state.json', json.dumps(state))


def load(token):
    state = json.loads((STATE / 'state.json').read_text())
    if not secrets.compare_digest(state['token'], token):
        raise RuntimeError('неверный идентификатор смены порта')
    return state


def apply(state, target):
    for path, entry in state['files'].items():
        text = re.sub(r'(?im)^\s*Port\s+[^\n]+', '', entry['text'])
        if path == str(Path(CONFIG).resolve()):
            text = ''.join('Port %d\n' % port for port in target) + text
        write(path, text, entry['mode'])
    if state['socket']:
        listeners = ''.join('ListenStream=%s\n' % (str(p) if address == '*' else address + ':' + str(p))
                            for address in state['socketAddresses'] for p in target)
        write(state['socketPath'], '[Socket]\nListenStream=\n' + listeners)
    if ports() != sorted(target):
        raise RuntimeError('действующие порты sshd не совпали с ожидаемыми; требуется ручная проверка Include')
    reload_ssh(state)
    if FAIL2BAN.is_dir():
        write(state['fail2banPath'], '[sshd]\nport = ' + ','.join(str(p) for p in target) + '\n')
        if active('fail2ban.service'):
            run(['fail2ban-client', 'reload', 'sshd'])


def rollback(token):
    if not (STATE / 'state.json').exists():
        return {'ok': True}
    state = load(token)
    if state['stage'] == 'verified':
        apply(state, sorted(set(state['old'] + [state['port']])))
        return {'ok': True}
    for path, entry in state['files'].items():
        write(path, entry['text'], entry['mode'])
    if state['socket']:
        if state['socketOld'] is None:
            Path(state['socketPath']).unlink(missing_ok=True)
        else:
            write(state['socketPath'], state['socketOld'])
    reload_ssh(state)
    if state.get('fail2banOld') is not None:
        write(state['fail2banPath'], state['fail2banOld'])
    else:
        Path(state['fail2banPath']).unlink(missing_ok=True)
    if active('fail2ban.service'):
        run(['fail2ban-client', 'reload', 'sshd'])
    for rule in state.get('addedRules', []):
        if rule in ufw_rules():
            run(['ufw', '--force', 'delete', *rule])
    run(['systemctl', 'stop', 'vps-ssh-port-' + token + '.timer'], False)
    (STATE / 'state.json').unlink()
    return {'ok': True}


def ufw_rules():
    if run(['sh', '-c', 'command -v ufw'], False).returncode:
        return []
    return [shlex.split(line)[1:] for line in run(['ufw', 'show', 'added']).stdout.splitlines()
            if line.startswith('ufw ')]


def fingerprints():
    result = [run(['ssh-keygen', '-lf', pub, '-E', 'sha256']).stdout.split()[1]
              for pub in glob.glob('/etc/ssh/ssh_host_*_key.pub')]
    if not result:
        raise RuntimeError('не найдены ключи хоста SSH')
    return result


def arm(state):
    unit = 'vps-ssh-port-' + state['token']
    if run(['systemctl', 'restart', unit + '.timer'], False).returncode == 0:
        return
    run(['systemd-run', '--quiet', '--collect', '--unit=' + unit,
         '--on-active=5m', '--property=Restart=on-failure', '--property=RestartSec=10s',
         'python3', str(STATE / 'recover.py'), 'rollback', state['token']])


def prepare(request):
    if (STATE / 'state.json').exists():
        pending = json.loads((STATE / 'state.json').read_text())
        if pending['stage'] == 'verified' and pending['port'] == request.get('port'):
            return dict(token=pending['token'], port=pending['port'], oldPorts=pending['old'], fingerprints=fingerprints())
        raise RuntimeError('смена порта уже подготовлена; для завершения повторите порт %s или дождитесь отката' % pending['port'])
    port = validate_port(request['port'])
    old = ports()
    if not old:
        raise RuntimeError('не удалось определить порты SSH')
    run(['sshd', '-t'])
    service = next((u for u in ('ssh.service', 'sshd.service') if active(u)), None)
    if not service:
        raise RuntimeError('работающая служба SSH не найдена')
    command = run(['systemctl', 'show', service, '--property=ExecStart', '--value']).stdout
    if re.search(r'\s-[fpo](?:\s|\S)', command):
        raise RuntimeError('служба SSH переопределяет конфигурацию или порт; сначала согласуйте ExecStart вручную')
    # EnvironmentFile может подставлять -f/-p через SSHD_OPTS, не раскрытые в ExecStart.
    for env_file in ('/etc/default/ssh', '/etc/sysconfig/sshd'):
        if Path(env_file).exists():
            text = Path(env_file).read_text()
            for value in re.findall(r'(?m)^\s*(?:SSHD_OPTS|OPTIONS)\s*=\s*(.*)$', text):
                if re.search(r'(?:^|[\s\"\'])-[fpo]', value):
                    raise RuntimeError('параметры службы SSH переопределяют порт или конфигурацию; сначала согласуйте их вручную')
    socket_unit = next((u for u in ('ssh.socket', 'sshd.socket') if active(u)), '')
    socket_addresses = []
    if socket_unit:
        if run(['systemctl', 'show', service, '--property=KillMode', '--value']).stdout.strip() != 'process':
            raise RuntimeError('для смены socket-порта с сохранением сессий требуется KillMode=process у службы SSH')
        listening = run(['systemctl', 'show', socket_unit, '--property=Listen', '--value']).stdout
        actual = re.findall(r'(\S+):(\d+) \(Stream\)', listening)
        if not actual:
            raise RuntimeError('не удалось прочитать порты SSH socket')
        old = sorted({int(p) for _, p in actual})
        socket_addresses = sorted({address for address, _ in actual})
        if any(address not in ('[::]', '0.0.0.0', '*') for address in re.findall(r'(\S+):\d+ \(Stream\)', listening)):
            raise RuntimeError('SSH socket привязан к отдельному адресу; сначала согласуйте ListenStream вручную')
    if port not in old and (port in reserved_ports() or not free(port)):
        raise RuntimeError('порт занят TCP/UDP-службой; выберите другой')
    socket_path = str(SYSTEMD / (socket_unit + '.d') / '90-vps-port.conf')
    state = dict(token=secrets.token_hex(16), port=port, old=old, files=config_files(),
                 service=service, socket=socket_unit, socketPath=socket_path, socketAddresses=socket_addresses,
                 socketOld=Path(socket_path).read_text() if Path(socket_path).exists() else None,
                 stage='prepared')
    state['fail2banPath'] = str(FAIL2BAN / 'jail.d/99-vps-ssh-port.local')
    state['fail2banOld'] = Path(state['fail2banPath']).read_text() if Path(state['fail2banPath']).exists() else None
    save(state)
    source = os.environ.get('VPS_SSH_PORT_SOURCE') or Path(__file__).read_text()
    write(STATE / 'recover.py', source, 0o700)
    try:
        arm(state)
        existing = ufw_rules()
        added = []
        for rule in existing:
            if not any(str(p) in rule or str(p) + '/tcp' in rule for p in old) and 'OpenSSH' not in rule:
                continue
            changed = [str(port) if v in [str(p) for p in old] else
                       str(port) + '/tcp' if v == 'OpenSSH' or v in [str(p) + '/tcp' for p in old] else v for v in rule]
            if changed != rule and changed not in existing and changed not in added:
                added.append(changed)
        state['addedRules'] = added
        save(state)
        for rule in added:
            run(['ufw', *rule])
        apply(state, sorted(set(old + [port])))
        return dict(token=state['token'], port=port, oldPorts=old, fingerprints=fingerprints())
    except Exception:
        rollback(state['token'])
        raise


def commit(token):
    state = load(token)
    # После подтверждения оба проверенных пути остаются рабочими, даже если панель завершится
    # до сохранения порта в базе. Таймер восстанавливает оба проверенных пути.
    arm(state)
    state['stage'] = 'verified'
    save(state)
    return {'ok': True}


def finish(token):
    state = load(token)
    if state['stage'] != 'verified':
        raise RuntimeError('сначала проверьте вход через новый порт')
    try:
        apply(state, [state['port']])
        # Явно заданный порт port-sync должен совпадать с новым портом sshd.
        conf = PORTSYNC
        if conf.exists():
            cfg = json.loads(conf.read_text())
            cfg['ssh_port'] = state['port']
            write(conf, json.dumps(cfg))
        if Path('/usr/local/sbin/vps-portsync').exists():
            run(['/usr/local/sbin/vps-portsync'])
    except Exception:
        apply(state, sorted(set(state['old'] + [state['port']])))
        raise
    run(['systemctl', 'stop', 'vps-ssh-port-' + token + '.timer'], False)
    (STATE / 'state.json').unlink()
    return {'ok': True}


def main():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        mode = sys.argv[1]
        request = json.load(sys.stdin) if len(sys.argv) == 2 else {'token': sys.argv[2]}
        if len(sys.argv) == 3 and (STATE / 'state.json').exists():
            if json.loads((STATE / 'state.json').read_text())['token'] != request['token']:
                return
        if mode == 'pick':
            result = {'port': choose()}
        elif mode == 'prepare':
            result = prepare(request)
        elif mode in ('commit', 'finish', 'rollback'):
            result = globals()[mode](request['token'])
        else:
            raise RuntimeError('неизвестная операция SSH')
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
