import json
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sshport as m


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
                                PORTSYNC=root / 'portsync', SYSTEMD=root / 'systemd', run=self.run_command,
                                reserved_ports=lambda: set(), fingerprints=lambda: ['SHA256:test']).items():
            patcher = patch.object(m, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        m.STATE.mkdir()
        m.FAIL2BAN.mkdir()
        m.PORTSYNC.write_text('{"ssh_port":2222,"admin_ips":["203.0.113.5"]}')
        self.addCleanup(self.tmp.cleanup)

    def run_command(self, args, check=True):
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
