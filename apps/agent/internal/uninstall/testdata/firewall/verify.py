"""Повторное сохранение Docker firewall в отдельном сетевом пространстве контейнера."""
import importlib.util
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location('uninstall', '/test/uninstall.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
engine = module.Engine()


def ipt(*args):
    return subprocess.check_output(['iptables', '-w', '5', *args], text=True)


def install_portsync(port):
    ipt('-N', 'VPS-PORTSYNC')
    ipt('-A', 'VPS-PORTSYNC', '!', '-i', 'eth0', '-j', 'RETURN')
    ipt('-A', 'VPS-PORTSYNC', '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'RETURN')
    ipt('-A', 'VPS-PORTSYNC', '-p', 'tcp', '-m', 'conntrack', '--ctorigdstport', port, '-j', 'RETURN')
    ipt('-A', 'VPS-PORTSYNC', '-j', 'LOG', '--log-prefix', '[VPS-PORTSYNC DROP] ')
    ipt('-A', 'VPS-PORTSYNC', '-j', 'DROP')
    ipt('-I', 'DOCKER-USER', '1', '-j', 'VPS-PORTSYNC')


ipt('-N', 'DOCKER-USER')
ipt('-A', 'DOCKER-USER', '-s', '198.51.100.10', '-j', 'RETURN')
for port in ('8080', '8443'):
    install_portsync(port)
    engine.check_container_firewall()
    engine.preserve_container_firewall()
    engine.check_container_firewall()
    rules = ipt('-S', 'CONTAINER-GUARD')
    assert '--ctorigdstport ' + port in rules
    if port == '8443':
        assert '8080' not in rules
    parent = ipt('-S', 'DOCKER-USER')
    assert parent.count('-j CONTAINER-GUARD') == 1
    assert 'VPS-PORTSYNC' not in parent
    assert '198.51.100.10/32 -j RETURN' in parent
    assert subprocess.run(['iptables', '-S', 'VPS-PORTSYNC'], capture_output=True).returncode != 0
    # Повторный запуск сохранённого скрипта, как при старте Docker.
    subprocess.run([module.CONTAINER_FIREWALL], check=True, capture_output=True)
    assert ipt('-S', 'CONTAINER-GUARD') == rules
    assert ipt('-S', 'DOCKER-USER') == parent

Path('/usr/local/sbin/vps-portsync').write_text('fixture')
saved = Path(module.CONTAINER_FIREWALL).read_text()
ipt('-A', 'CONTAINER-GUARD', '-s', '198.51.100.20', '-j', 'DROP')
plan = engine.scan()
assert next(i for i in plan['items'] if i['id'] == 'portsync')['blockers']
assert Path(module.CONTAINER_FIREWALL).read_text() == saved
assert '198.51.100.20/32' in ipt('-S', 'CONTAINER-GUARD')
print('OK: повторная очистка обновляет свою защиту; чужие правила сохранены и блокируют очистку до изменений')
