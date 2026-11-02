"""Проверка собранного агента через настоящий парольный SSH в отдельном контейнере."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

spec = importlib.util.spec_from_file_location('uninstall', '/test/uninstall.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
engine = module.Engine()
subprocess.run(['/usr/sbin/sshd'], check=True)
Path('/etc/vps-agent').mkdir()
Path('/etc/vps-agent/agent.json').write_text('{}')
shutil.copy('/test/vps-agent', '/usr/local/bin/vps-agent')
Path('/usr/local/bin/vps-agent').chmod(0o755)
Path('/root/.ssh').mkdir(exist_ok=True)
Path('/root/.ssh/authorized_keys').write_text('ssh-ed25519 AAAA panel\nssh-ed25519 BBBB owner\n')
Path('/etc/wdtt').mkdir()
Path('/etc/wdtt/passwords.json').write_text('secret-fixture')
Path('/etc/security-preserved').write_text('keep')
detach = os.environ.get('TEST_MODE') == 'detach'
partial = os.environ.get('TEST_MODE') == 'partial'
Path('/var/log/auth.log').touch()
Path('/var/log/x-ui').mkdir()
Path('/var/log/x-ui/3xipl.log').touch()
Path('/etc/fail2ban/jail.d/sshd.local').write_text('[sshd]\nenabled = true\nlogpath = /var/log/auth.log\naction = dummy\n')
Path('/etc/fail2ban/jail.d/3x-ipl.conf').write_text('[3x-ipl]\nenabled = true\nbackend = auto\nfilter = 3x-ipl\nlogpath = /var/log/x-ui/3xipl.log\naction = 3x-ipl\n')
Path('/etc/fail2ban/jail.d/3x-ipl-backend.conf').write_text('[DEFAULT]\nbackend = systemd\n')
Path('/etc/fail2ban/filter.d/3x-ipl.conf').write_text('[Definition]\nfailregex = ^<HOST> exceeded$\n')
Path('/etc/fail2ban/action.d/3x-ipl.conf').write_text('[INCLUDES]\nbefore = dummy.conf\n')
subprocess.run(['fail2ban-client', 'start'], check=True)
subprocess.run(['fail2ban-client', 'set', 'sshd', 'banip', '198.51.100.42'], check=True)
if partial:
    shutil.rmtree('/var/log/x-ui')
    Path('/usr/local/sbin/container-firewall').write_text('preserved firewall fixture')
    assert subprocess.run(['fail2ban-client', 'reload'], capture_output=True).returncode != 0
plan = engine.scan()
request = dict(revision=plan['revision'], ids=[i['id'] for i in plan['items'] if not detach or i['id'] in ('agent', 'portsync')], password='isolated-test-password', detachOnly=detach)
original_config = Path('/etc/ssh/sshd_config').read_text()
original_shadow = Path('/etc/shadow').read_text().splitlines()[0].split(':')[1]
rollback = engine.prepare(request)
engine.rollback(rollback['token'])
assert Path('/etc/ssh/sshd_config').read_text() == original_config
assert Path('/etc/shadow').read_text().splitlines()[0].split(':')[1] == original_shadow
assert Path('/etc/vps-agent/agent.json').exists()
prepared = engine.prepare(request)
assert 'PasswordAuthentication yes' in Path('/etc/ssh/sshd_config').read_text()
askpass = Path('/test-askpass')
askpass.write_text("#!/usr/bin/python3\nimport os\nprint(os.environ['TEST_PASSWORD'])\n")
askpass.chmod(0o700)
known = Path('/test-known-hosts')
known.write_text(''.join('127.0.0.1 ' + p.read_text() for p in Path('/etc/ssh').glob('ssh_host_*_key.pub')))
env = {**os.environ, 'SSH_ASKPASS': str(askpass), 'SSH_ASKPASS_REQUIRE': 'force', 'DISPLAY': ':0', 'TEST_PASSWORD': request['password']}
ssh = ['ssh', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known),
       '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
       '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=10', 'root@127.0.0.1']
subprocess.run(ssh + ['true'], check=True, env=env, stdin=subprocess.DEVNULL)
request.pop('password')
request.update(token=prepared['token'], remote=True, panelKey='ssh-ed25519 AAAA panel')
result = subprocess.run(ssh + ['/usr/local/bin/vps-agent -uninstall-run'], input=json.dumps(request), text=True, env=env, capture_output=True)
print(result.stdout)
assert result.returncode == 0, result.stderr
assert Path('/etc/wdtt').exists() == detach
if detach: assert Path('/etc/wdtt/passwords.json').read_text() == 'secret-fixture'
assert not Path('/etc/vps-agent').exists()
assert not Path('/usr/local/bin/vps-agent').exists()
assert 'AAAA' not in Path('/root/.ssh/authorized_keys').read_text()
assert 'BBBB' in Path('/root/.ssh/authorized_keys').read_text()
assert Path('/etc/security-preserved').read_text() == 'keep'
subprocess.run(['fail2ban-client', '-t'], check=True)
jails = subprocess.check_output(['fail2ban-client', 'status'], text=True)
assert ('3x-ipl' in jails) == detach
assert 'sshd' in jails
assert '198.51.100.42' in subprocess.check_output(['fail2ban-client', 'get', 'sshd', 'banip'], text=True)
assert Path('/etc/fail2ban/jail.d/sshd.local').exists()
assert Path('/etc/fail2ban/jail.d/3x-ipl-backend.conf').read_text() == '[DEFAULT]\nbackend = systemd\n'
if partial:
    assert Path('/usr/local/sbin/container-firewall').read_text() == 'preserved firewall fixture'
subprocess.run(ssh + ['true'], check=True, env=env, stdin=subprocess.DEVNULL)
print('OK: новый пароль работает после удаления агента, ключ владельца и посторонний файл сохранены')
