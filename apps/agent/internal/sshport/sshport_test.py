import json
import importlib.util
import fcntl
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch
import sshport as m

spec = importlib.util.spec_from_file_location('portsync_script',
    Path(__file__).resolve().parent / '../baseline/assets/vps-portsync.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PortChangeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.config = root / 'sshd_config'
        self.include = root / 'included.conf'
        self.config.write_text('Include ' + str(self.include) + '\nPasswordAuthentication no\n')
        self.include.write_text('Port 2222\nPermitRootLogin prohibit-password\n')
        self.rules = [['allow', 'from', '203.0.113.5', 'to', 'any', 'port', '2222', 'proto', 'tcp']]
        self.calls, self.socket, self.fail = [], False, None
        for name, value in dict(CONFIG=str(self.config), STATE=root / 'state', FAIL2BAN=root / 'fail2ban',
                                PORTSYNC=root / 'portsync', PORTSYNC_BIN=root / 'vps-portsync',
                                PORTSYNC_LOCK=root / 'portsync.lock', SYSTEMD=root / 'systemd', run=self.run_command,
                                reserved_ports=lambda: set(), fingerprints=lambda: ['SHA256:test']).items():
            patcher = patch.object(m, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        m.STATE.mkdir()
        m.FAIL2BAN.mkdir()
        m.PORTSYNC.write_text('{"ssh_port":2222,"admin_ips":["203.0.113.5"]}')
        self.addCleanup(self.tmp.cleanup)

    def run_command(self, args, check=True, **kwargs):
        self.calls.append(args)
        if self.fail and args[:len(self.fail)] == self.fail:
            self.fail = None
            raise RuntimeError('ошибка команды')
        code, out = 0, ''
        if args == ['sshd', '-T']:
            out = '\n'.join('port ' + p for text in (self.config.read_text(), self.include.read_text())
                            for p in re.findall(r'(?im)^Port (\d+)$', text))
        elif args[:2] == ['systemctl', 'is-active']:
            code = 0 if args[-1] in ('ssh.service', 'fail2ban.service') or (self.socket and args[-1] == 'ssh.socket') else 3
        elif args[:2] == ['systemctl', 'restart'] and args[-1].endswith('.timer'):
            code = 1
        elif '--property=ExecStart' in args:
            out = '/usr/sbin/sshd -D'
        elif '--property=KillMode' in args:
            out = 'process'
        elif '--property=Listen' in args:
            out = '[::]:2222 (Stream)'
        elif args == ['ufw', 'show', 'added']:
            out = '\n'.join('ufw ' + ' '.join(r) for r in self.rules)
        elif args[:3] == ['ufw', '--force', 'delete']:
            self.rules.remove(args[3:])
        elif args[0] == 'ufw':
            self.rules.append(args[1:])
        return subprocess.CompletedProcess(args, code, out, '')

    def enable_portsync(self):
        """Настоящий планировщик UFW и state.json, подменены только команды ОС."""
        m.PORTSYNC_BIN.touch()
        self.sync_failures = 0
        self.sync_calls = 0
        self.ufw_failure = None
        self.firewall_events = []
        self.rules = [p.ufw_rule_args('tcp', 2222, label='SSH'),
                      p.ufw_rule_args('tcp', 2222, '203.0.113.5', 'SSH admin')]
        for name, value in dict(LOCK=str(m.PORTSYNC_LOCK), SSH_TRANSITION=str(m.STATE / 'state.json'),
                                STATE=str(m.STATE / 'portsync-state.json'), STATE_DIR=str(m.STATE),
                                agent_state=self.desired, run=self.firewall_command,
                                ufw_present=lambda: set(), ufw_ipv6=lambda: True).items():
            patcher = patch.object(p, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        p.save_state({'ufw_rules': list(self.rules)})
        patcher = patch.object(m, 'run', self.transaction_command)
        patcher.start()
        self.addCleanup(patcher.stop)

    def desired(self):
        port = json.loads(m.PORTSYNC.read_text()).get('ssh_port', 2222) if m.PORTSYNC.exists() else m.ports()[0]
        return dict(ssh_port=port, host_allow=[('tcp', port)], admin_ips=['203.0.113.5'],
                    labels={str(port) + '/tcp': 'SSH'}, docker_allow=[], docker_labels={},
                    wan_interface='eth0', unknown_listeners=[], findings=[])

    def periodic_sync(self, args=None):
        with patch.object(sys, 'argv', [str(m.PORTSYNC_BIN), *(args or [])]):
            return p.main()

    def firewall_command(self, args, check=False, **kwargs):
        if args[0] == 'iptables':
            return 1, ''
        if self.ufw_failure and args[:len(self.ufw_failure)] == self.ufw_failure:
            self.ufw_failure = None
            if check:
                raise RuntimeError('ufw отказ')
            return 1, ''
        self.firewall_events.append((list(args), m.ports()))
        deleting = args[1] in ('delete', '--force')
        rule = args[3:] if args[1] == '--force' else args[2:] if deleting else args[1:]
        self.rules = [r for r in self.rules if p.rule_base(r) != p.rule_base(rule)]
        if not deleting:
            self.rules.append(rule)
        return 0, ''

    def transaction_command(self, args, check=True, **kwargs):
        if args[0] == str(m.PORTSYNC_BIN):
            self.sync_calls += 1
            self.calls.append(args)
            self.assertEqual(kwargs['pass_fds'], (int(args[-1]),))
            result = self.periodic_sync(args[1:])
            if self.sync_failures:
                self.sync_failures -= 1
                raise RuntimeError('port-sync частично применён')
            if result:
                raise RuntimeError('port-sync отказ')
            return subprocess.CompletedProcess(args, 0, '', '')
        if args[0] == 'ufw' and args[1:3] != ['show', 'added']:
            self.firewall_command(args, check=check)
            return subprocess.CompletedProcess(args, 0, '', '')
        return self.run_command(args, check, **kwargs)

    def assert_both_paths(self):
        self.assertEqual(m.ports(), [2222, 24567])
        self.assertEqual(m.load(self.token)['stage'], 'verified')
        for port in (2222, 24567):
            self.assertTrue(any(str(port) in r for r in self.rules), self.rules)

    def verified_transition(self):
        self.enable_portsync()
        self.before = m.PORTSYNC.read_text()
        m.PORTSYNC.chmod(0o640)
        self.token = self.prepare()['token']
        m.commit(self.token)
        self.firewall_events.clear()

    def test_portsync_partial_failure_periodic_apply_and_retry(self):
        self.verified_transition()
        self.sync_failures = 1
        with self.assertRaisesRegex(RuntimeError, 'port-sync частично'):
            m.finish(self.token)
        self.assertEqual(m.PORTSYNC.read_text(), self.before)
        self.assertEqual(m.PORTSYNC.stat().st_mode & 0o777, 0o640)
        self.assert_both_paths()
        self.assertEqual(self.sync_calls, 2)
        # И обычный таймер, и независимый recovery сохраняют оба пути.
        for _ in range(2):
            self.periodic_sync()
            self.assert_both_paths()
        m.rollback(self.token)
        self.assert_both_paths()
        m.finish(self.token)
        self.assertEqual(m.ports(), [24567])
        self.assertFalse((m.STATE / 'state.json').exists())
        self.assertTrue(all(ports == [2222, 24567] for _, ports in self.firewall_events))
        self.periodic_sync()
        self.assertFalse(any('2222' in r for r in self.rules))
        self.assertTrue(any('24567' in r for r in self.rules))
        self.assertEqual(p.load_state()['ufw_rules'], self.rules)

    def test_recovery_failure_keeps_journal_and_independent_timer_can_retry(self):
        self.verified_transition()
        self.sync_failures = 2
        with self.assertRaisesRegex(RuntimeError, 'восстановление SSH/port-sync'):
            m.finish(self.token)
        self.assertEqual(m.PORTSYNC.read_text(), self.before)
        self.assert_both_paths()
        self.assertFalse(any(c[:2] == ['systemctl', 'stop'] and c[-1].endswith('.timer') for c in self.calls))
        m.rollback(self.token)
        self.periodic_sync()
        self.assert_both_paths()
        m.finish(self.token)

    def test_ufw_failure_is_not_success_and_retry_repairs_state(self):
        self.verified_transition()
        self.ufw_failure = ['ufw', 'allow']
        with self.assertRaisesRegex(RuntimeError, 'ufw отказ'):
            m.finish(self.token)
        self.assert_both_paths()
        self.assertEqual(m.PORTSYNC.read_text(), self.before)
        self.periodic_sync()
        self.assert_both_paths()
        m.finish(self.token)

    def test_reload_failure_after_portsync_restores_every_component(self):
        self.verified_transition()
        self.fail = ['systemctl', 'reload']
        with self.assertRaisesRegex(RuntimeError, 'ошибка команды'):
            m.finish(self.token)
        self.assertEqual(m.PORTSYNC.read_text(), self.before)
        self.periodic_sync()
        self.assert_both_paths()
        m.finish(self.token)

    def test_verified_recovery_after_interrupted_finish_restores_config(self):
        self.verified_transition()
        state = m.load(self.token)
        state['portsyncBeforeFinish'] = {'text': self.before, 'mode': 0o640}
        m.save(state)
        m.PORTSYNC.write_text('{"ssh_port":24567}')
        m.apply(state, [24567])
        m.rollback(self.token)
        self.assertEqual(m.PORTSYNC.read_text(), self.before)
        self.periodic_sync()
        self.assert_both_paths()

    def test_absent_config_is_not_created_during_recovery(self):
        self.verified_transition()
        m.PORTSYNC.unlink()
        self.sync_failures = 1
        with self.assertRaisesRegex(RuntimeError, 'port-sync частично'):
            m.finish(self.token)
        self.assertFalse(m.PORTSYNC.exists())
        self.periodic_sync()
        self.assert_both_paths()
        m.finish(self.token)

    def test_periodic_sync_protects_prepared_and_verified_rules(self):
        self.enable_portsync()
        self.token = self.prepare()['token']
        for _ in range(2):
            self.periodic_sync()
            self.assertTrue(any('24567' in r for r in self.rules))
        m.commit(self.token)
        self.periodic_sync()
        self.assert_both_paths()

    def test_recovery_repairs_firewall_even_when_ssh_reload_fails(self):
        self.verified_transition()
        self.rules = []
        self.fail = ['systemctl', 'reload']
        with self.assertRaisesRegex(RuntimeError, 'восстановление SSH/port-sync'):
            m.rollback(self.token)
        self.assertTrue(any('2222' in r for r in self.rules))
        self.assertTrue(any('24567' in r for r in self.rules))
        m.rollback(self.token)
        self.assert_both_paths()

    def test_ufw_add_failure_does_not_delete_old_rules(self):
        self.enable_portsync()
        m.PORTSYNC.write_text('{"ssh_port":24567}')
        self.ufw_failure = ['ufw', 'allow']
        with self.assertRaisesRegex(RuntimeError, 'ufw отказ'):
            self.periodic_sync()
        self.assertTrue(any('2222' in r for r in self.rules))
        self.assertFalse(any(args[1] == 'delete' for args, _ in self.firewall_events))
        self.periodic_sync()
        self.assertFalse(any('2222' in r for r in self.rules))
        self.assertEqual(p.load_state()['ufw_rules'], self.rules)

    def test_ufw_delete_failure_retains_retry_journal(self):
        self.enable_portsync()
        m.PORTSYNC.write_text('{"ssh_port":24567}')
        self.ufw_failure = ['ufw', 'delete']
        with self.assertRaisesRegex(RuntimeError, 'ufw отказ'):
            self.periodic_sync()
        self.assertTrue(any('24567' in r for r in self.rules))
        self.assertTrue(any('2222' in r for r in p.load_state()['ufw_rules']))
        self.periodic_sync()
        self.assertEqual(p.load_state()['ufw_rules'], self.rules)
        self.assertFalse(any('2222' in r for r in self.rules))

    def test_manual_rules_keep_source_restrictions_and_ownership(self):
        self.enable_portsync()
        manual = ['allow', 'from', '2001:db8::5', 'to', 'any', 'port', '2222', 'proto', 'tcp']
        self.rules.append(manual)
        self.token = self.prepare()['token']
        m.commit(self.token)
        self.periodic_sync()
        for rule in (manual, [v if v != '2222' else '24567' for v in manual]):
            self.assertIn(rule, self.rules)
            self.assertNotIn(rule, p.load_state()['ufw_rules'])
        m.finish(self.token)
        self.periodic_sync()
        self.assertIn(manual, self.rules)

    def test_corrupt_transition_journal_prevents_firewall_mutation(self):
        self.enable_portsync()
        (m.STATE / 'state.json').write_text('{broken')
        before = p.load_state()
        with self.assertRaises(ValueError):
            self.periodic_sync()
        self.assertEqual(p.load_state(), before)
        self.assertEqual(self.firewall_events, [])

    def test_periodic_process_reads_state_only_after_lock(self):
        self.enable_portsync()
        # Отдельный процесс и настоящий flock. Сигнал непосредственно перед flock
        # позволяет поменять конфиг, пока таймер ждёт, без sleep и гонок в тесте.
        code = '''
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('portsync', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.LOCK = sys.argv[2]
conf = sys.argv[3]
p.agent_state = lambda: dict(ssh_port=json.load(open(conf))['ssh_port'],
    host_allow=[], docker_allow=[], unknown_listeners=[], findings=[], wan_interface='eth0')
p.apply_ufw = lambda *a: None
p.apply_docker_chain = lambda *a: None
p.os.geteuid = lambda: 0
flock = p.fcntl.flock
def waiting(*args):
    print('locking', flush=True)
    return flock(*args)
p.fcntl.flock = waiting
sys.argv = ['portsync', '--plan']
sys.exit(p.main())
'''
        with m.PORTSYNC_LOCK.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            child = subprocess.Popen([sys.executable, '-c', code, p.__file__, str(m.PORTSYNC_LOCK), str(m.PORTSYNC)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'locking')
                m.PORTSYNC.write_text('{"ssh_port":24567}')
                fcntl.flock(lock, fcntl.LOCK_UN)
                out, err = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, err)
                self.assertIn('ssh: 24567', out)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate()

    def test_inherited_lock_works_in_real_child_process(self):
        self.enable_portsync()
        code = '''
import importlib.util, sys
spec = importlib.util.spec_from_file_location('portsync', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.LOCK = sys.argv[2]
p.execute = lambda args: 0
p.os.geteuid = lambda: 0
sys.argv = ['portsync', '--lock-fd', sys.argv[3]]
sys.exit(p.main())
'''
        with m.PORTSYNC_LOCK.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run([sys.executable, '-c', code, p.__file__, str(m.PORTSYNC_LOCK), str(lock.fileno())],
                                    pass_fds=(lock.fileno(),), capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)

    def prepare(self):
        with patch.object(m, 'free', return_value=True):
            return m.prepare({'port': 24567})

    def test_two_ports_then_commit_and_finish(self):
        prepared = self.prepare()
        self.assertEqual(m.ports(), [2222, 24567])
        self.assertIn('203.0.113.5', self.rules[-1])
        m.commit(prepared['token'])
        self.assertEqual(m.ports(), [2222, 24567])
        m.finish(prepared['token'])
        self.assertEqual(m.ports(), [24567])
        self.assertEqual(json.loads(m.PORTSYNC.read_text())['ssh_port'], 24567)
        self.assertIn('24567', (m.FAIL2BAN / 'jail.d/99-vps-ssh-port.local').read_text())
        self.assertFalse((m.STATE / 'state.json').exists())
        m.rollback(prepared['token'])

    def test_timeout_restores_original_config_and_firewall(self):
        original = (self.config.read_text(), self.include.read_text())
        prepared = self.prepare()
        m.rollback(prepared['token'])
        self.assertEqual((self.config.read_text(), self.include.read_text()), original)
        self.assertEqual(len(self.rules), 1)

    def test_lost_commit_reply_preserves_both_paths_and_can_resume(self):
        prepared = self.prepare()
        m.commit(prepared['token'])
        m.rollback(prepared['token'])
        self.assertEqual(m.ports(), [2222, 24567])
        resumed = m.prepare({'port': 24567})
        self.assertEqual(resumed['token'], prepared['token'])
        m.finish(resumed['token'])
        self.assertEqual(m.ports(), [24567])

    def test_finish_failure_keeps_old_and_new(self):
        prepared = self.prepare()
        m.commit(prepared['token'])
        self.fail = ['systemctl', 'reload']
        with self.assertRaisesRegex(RuntimeError, 'ошибка'):
            m.finish(prepared['token'])
        self.assertEqual(m.ports(), [2222, 24567])
        m.finish(prepared['token'])

    def test_timer_failure_does_not_change_access(self):
        self.fail = ['systemd-run']
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertEqual(m.ports(), [2222])
        self.assertEqual(len(self.rules), 1)

    def test_prepare_failure_rolls_back(self):
        self.fail = ['systemctl', 'reload']
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertEqual(m.ports(), [2222])
        self.assertEqual(len(self.rules), 1)

    def test_wrong_token_and_unverified_finish_rejected(self):
        prepared = self.prepare()
        with self.assertRaisesRegex(RuntimeError, 'идентификатор'):
            m.commit('bad')
        with self.assertRaisesRegex(RuntimeError, 'проверьте'):
            m.finish(prepared['token'])

    def test_config_include_and_match_preserved(self):
        self.include.write_text('Port 2222\nMatch User test\n PasswordAuthentication no\n')
        prepared = self.prepare()
        m.commit(prepared['token'])
        m.finish(prepared['token'])
        self.assertIn('Match User test\n PasswordAuthentication no', self.include.read_text())

    def test_explicit_listen_port_rejected_before_change(self):
        self.include.write_text('Port 2222\nListenAddress 127.0.0.1:2222\n')
        with self.assertRaisesRegex(RuntimeError, 'ListenAddress'):
            self.prepare()
        self.assertFalse((m.STATE / 'state.json').exists())

    def test_socket_activation_restores_dropin(self):
        self.socket = True
        prepared = self.prepare()
        path = m.SYSTEMD / 'ssh.socket.d/90-vps-port.conf'
        self.assertIn('ListenStream=[::]:24567', path.read_text())
        self.assertIn(['systemctl', 'stop', 'ssh.service'], self.calls)
        m.rollback(prepared['token'])
        self.assertFalse(path.exists())
        self.assertEqual(m.ports(), [2222])

    def test_busy_and_reserved_ports_rejected(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
            self.assertFalse(m.free(port))
            with self.assertRaisesRegex(RuntimeError, 'занят'):
                m.prepare({'port': port})
        with patch.object(m, 'reserved_ports', return_value={24567}):
            with self.assertRaisesRegex(RuntimeError, 'занят'):
                self.prepare()

    def test_range_and_random(self):
        for value in (0, 1, 1023, 65536, 2.5, True, '2222'):
            with self.assertRaises(ValueError):
                m.validate_port(value)
        for value in (22, 1024, 65535):
            self.assertEqual(m.validate_port(value), value)
        picked = m.choose()
        self.assertGreaterEqual(picked, 1024)
        self.assertLessEqual(picked, 65535)
        self.assertTrue(m.free(picked))


if __name__ == '__main__':
    unittest.main()
