"""Очистка на временной файловой системе. Системные команды не выполняются."""
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from uninstall import CleanupError, Engine, SSH_BLOCK, STATE_DIR


class FakeEngine(Engine):
    def __init__(self, root):
        super().__init__(root)
        self.calls = []
        self.containers = []
        self.available = set()
        self.failure = None
        self.ssh_bad = False

    def has(self, name):
        return name in self.available

    def docker(self):
        return list(self.containers)

    def run(self, args, *, input=None, check=True, env=None):
        self.calls.append((args, input))
        code, out = 0, ""
        if self.failure and args[:len(self.failure)] == self.failure:
            raise CleanupError("ошибка команды " + args[0])
        if args[:2] == ["sshd", "-T"]:
            out = "permitrootlogin yes\npasswordauthentication " + ("no" if self.ssh_bad else "yes") + "\nauthenticationmethods any\nport 2222\n"
        elif args[:2] == ["ssh-keygen", "-lf"]:
            out = "256 SHA256:known root (ED25519)\n"
        elif args[:2] == ["chpasswd", "-e"]:
            self.write("/etc/shadow", "root:" + input.split(":", 1)[1].strip() + ":1:0:99999:7:::\n")
        elif args == ["chpasswd"]:
            self.write("/etc/shadow", "root:new-hash:1:0:99999:7:::\n")
        elif args[:2] == ["systemctl", "is-active"]:
            code = 0 if args[-1] == "ssh.service" else 3
        elif args[:2] == ["docker", "rm"]:
            self.containers = [c for c in self.containers if c["Id"] != args[-1]]
        elif args[:3] == ["docker", "network", "inspect"]:
            code = 1
        elif args[0] in ("id", "getent") or args[:3] == ["ip", "link", "show"]:
            code = 1
        elif args[:2] == ["crontab", "-l"]:
            out = "10 0 * * * /root/.acme.sh/acme.sh --cron\n0 0 * * * /usr/local/bin/own-backup\n"
        return subprocess.CompletedProcess(args, code, out, "")


def container(name, mounts=None, project=None, service=None):
    return {"Id": "id-" + name, "Name": "/" + name, "Image": "image-" + name,
            "Config": {"Image": "image-" + name, "Labels": {
                "com.docker.compose.project": project, "com.docker.compose.service": service}},
            "Mounts": mounts or []}


class UninstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.e = FakeEngine(self.tmp.name)
        self.e.write("/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\n")
        self.e.write("/etc/shadow", "root:old-hash:1:0:99999:7:::\n")
        self.e.write("/etc/ssh/ssh_host_ed25519_key.pub", "ssh-ed25519 AAAA host\n")
        self.e.write("/etc/vps-agent/agent.json", "{}")
        self.e.write("/usr/local/bin/vps-agent", "binary")
        self.e.write("/root/.ssh/authorized_keys", 'command="echo hello" ssh-ed25519 AAAA panel\nssh-ed25519 BBBB owner\n')
        self.e.write("/root/.ssh/authorized_keys.vps-panel.bak", "old keys")

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, extra=()):
        plan = self.e.scan()
        return dict(revision=plan["revision"], ids=[i["id"] for i in plan["items"] if i["owned"]] + list(extra),
                    password="new-root-password", panelKey="ssh-ed25519 AAAA panel", localVerified=True)

    def prepared(self, extra=()):
        req = self.request(extra)
        req["token"] = self.e.prepare(req)["token"]
        req.pop("password")
        return req

    def execute(self, req):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.e.execute(req)
        return out.getvalue()

    def test_unknown_service_requires_selection(self):
        self.e.write("/etc/wdtt/passwords.json", "secret")
        plan = self.e.scan()
        self.assertFalse(next(i for i in plan["items"] if i["id"] == "wdtt")["owned"])
        self.execute(self.prepared())
        self.assertEqual(self.e.text("/etc/wdtt/passwords.json"), "secret")

    def test_full_selected_cleanup_preserves_security_and_owner_key(self):
        self.e.write("/etc/wdtt/passwords.json", "secret")
        self.e.write("/etc/fail2ban/jail.local", "security")
        self.e.write("/etc/apt/apt.conf.d/20auto-upgrades", "updates")
        self.e.write("/etc/ufw/user.rules", "firewall")
        self.e.write("/var/log/auth.log", "audit")
        req = self.prepared(("wdtt",))
        out = self.execute(req)
        self.assertFalse(self.e.exists("/etc/wdtt"))
        self.assertFalse(self.e.exists("/etc/vps-agent"))
        self.assertNotIn("AAAA", self.e.text("/root/.ssh/authorized_keys"))
        self.assertIn("BBBB", self.e.text("/root/.ssh/authorized_keys"))
        self.assertFalse(self.e.exists("/root/.ssh/authorized_keys.vps-panel.bak"))
        for p in ("/etc/fail2ban/jail.local", "/etc/apt/apt.conf.d/20auto-upgrades", "/etc/ufw/user.rules", "/var/log/auth.log"):
            self.assertTrue(self.e.exists(p))
        self.assertNotIn("new-root-password", out)
        self.assertNotIn("old-hash", out)
        self.assertIn(SSH_BLOCK, self.e.text("/etc/ssh/sshd_config"))

    def test_changed_server_has_no_mutation(self):
        req = self.request()
        self.e.containers.append(container("foreign"))
        with self.assertRaisesRegex(CleanupError, "состав сервера изменился"):
            self.e.prepare(req)
        self.assertTrue(all(args[0] == 'getent' for args, _ in self.e.calls))
        self.assertTrue(self.e.exists("/etc/vps-agent"))

    def test_panel_sites_block_before_password_change(self):
        self.e.write("/opt/vps-panel/compose.yml", "panel")
        self.e.write("/opt/vps-panel/sites/foreign.caddy", "site")
        with self.assertRaisesRegex(CleanupError, "перенести сторонние сайты"):
            self.e.prepare(self.request())
        self.assertTrue(all(args[0] == 'getent' for args, _ in self.e.calls))

    def test_remote_cannot_clean_panel_even_if_panel_api_misidentifies_host(self):
        self.e.write("/opt/vps-panel/.env", "PANEL_DOMAIN=example.com")
        with self.assertRaisesRegex(CleanupError, "только командой по SSH"):
            self.e.prepare({**self.request(), "remote": True})

    def test_unrelated_bind_mount_blocks_selected_directory(self):
        self.e.write("/etc/wdtt/passwords.json", "secret")
        self.e.containers.append(container("foreign", [{"Type": "bind", "Source": "/etc/wdtt"}]))
        with self.assertRaisesRegex(CleanupError, "сохраняемый контейнер"):
            self.e.prepare(self.request(("wdtt",)))

    def test_parent_symlink_is_never_followed(self):
        outside = Path(self.tmp.name, "foreign")
        outside.mkdir()
        (outside / "passwords.json").write_text("foreign")
        self.e.path("/etc/wdtt").symlink_to(outside)
        self.e.remove("/etc/wdtt")
        self.assertEqual((outside / "passwords.json").read_text(), "foreign")
        self.e.path("/etc/wdtt").symlink_to(outside)
        with self.assertRaises(CleanupError):
            self.e.remove("/etc/wdtt/passwords.json")

    def test_mount_inside_directory_blocks_deletion(self):
        self.e.write("/etc/wdtt/passwords.json", "secret")
        self.e.write("/proc/self/mountinfo", "1 2 8:1 / /etc/wdtt/data rw - ext4 disk rw\n")
        with self.assertRaisesRegex(CleanupError, "точка монтирования"):
            self.e.prepare(self.request(("wdtt",)))

    def test_password_preparation_can_be_rolled_back(self):
        config = self.e.text("/etc/ssh/sshd_config")
        prepared = self.e.prepare(self.request())
        self.assertIn("new-hash", self.e.text("/etc/shadow"))
        self.e.rollback(prepared["token"])
        self.assertIn("old-hash", self.e.text("/etc/shadow"))
        self.assertEqual(self.e.text("/etc/ssh/sshd_config"), config)
        self.e.rollback(prepared["token"])

    def test_effective_ssh_rejection_rolls_back_without_removing_agent(self):
        self.e.ssh_bad = True
        config = self.e.text("/etc/ssh/sshd_config")
        with self.assertRaisesRegex(CleanupError, "Match SSH"):
            self.e.prepare(self.request())
        self.assertEqual(self.e.text("/etc/ssh/sshd_config"), config)
        self.assertIn("old-hash", self.e.text("/etc/shadow"))
        self.assertTrue(self.e.exists("/etc/vps-agent"))

    def test_service_failure_keeps_agent_and_keys(self):
        self.e.write("/etc/systemd/system/wdtt.service", "service")
        req = self.prepared(("wdtt",))
        self.e.failure = ["systemctl", "stop", "wdtt.service"]
        with self.assertRaises(CleanupError):
            self.execute(req)
        self.assertTrue(self.e.exists("/etc/vps-agent"))
        self.assertIn("AAAA", self.e.text("/root/.ssh/authorized_keys"))

    def test_unrelated_stopped_container_and_docker_are_preserved(self):
        self.e.available.add("docker")
        self.e.write("/etc/vps-agent/docker-installed", "")
        self.e.containers.extend([container("amnezia-awg2"), container("foreign")])
        self.execute(self.prepared(("container:amnezia-awg2",)))
        self.assertEqual([c["Name"] for c in self.e.containers], ["/foreign"])
        self.assertFalse(any(args[0] == "apt-get" for args, _ in self.e.calls))

    def test_shared_image_and_volume_are_preserved(self):
        self.e.available.add("docker")
        mount = {"Type": "volume", "Name": "shared"}
        own = container("caddy", [mount], "vps-panel", "caddy")
        foreign = container("foreign", [mount])
        foreign["Image"] = own["Image"]
        self.e.containers = [foreign]
        self.e.clean_docker_resources([own], {"panel"})
        self.assertFalse(any(args[:3] in (["docker", "image", "rm"], ["docker", "volume", "rm"]) for args, _ in self.e.calls))

    def test_selected_shared_volume_blocks_before_password_change(self):
        mount = {"Type": "volume", "Name": "shared"}
        self.e.containers = [container("amnezia-awg2", [mount]), container("foreign", [mount])]
        with self.assertRaisesRegex(CleanupError, "использует том"):
            self.e.prepare(self.request(("container:amnezia-awg2", "volume:shared")))
        self.assertFalse(any(args[0] == "chpasswd" for args, _ in self.e.calls))

    def test_container_storage_requires_separate_selection(self):
        self.e.write("/srv/vpn-data/secret", "secret")
        self.e.containers = [container("amnezia-awg2", [
            {"Type": "volume", "Name": "vpn-data"}, {"Type": "bind", "Source": "/srv/vpn-data"}])]
        plan = self.e.scan()
        storage = [i for i in plan["items"] if i["id"].startswith(("volume:", "bind:"))]
        self.assertEqual(len(storage), 2)
        self.assertTrue(all(not i["owned"] for i in storage))
        self.execute(self.prepared(("container:amnezia-awg2",)))
        self.assertTrue(self.e.exists("/srv/vpn-data/secret"))
        self.assertFalse(any(args[:3] == ["docker", "volume", "rm"] for args, _ in self.e.calls))

    def test_panel_without_agent_removes_data_volumes_and_exact_key(self):
        self.e.remove("/etc/vps-agent")
        self.e.remove("/usr/local/bin/vps-agent")
        self.e.write("/opt/vps-panel/compose.yml", "compose")
        self.e.write("/opt/vps-panel/data/panel_ssh_ed25519.pub", "ssh-ed25519 AAAA panel")
        self.e.containers = [container("caddy", [{"Type": "volume", "Name": "vps-panel_caddy_data"}], "vps-panel", "caddy")]
        self.execute(self.prepared())
        self.assertFalse(self.e.exists("/opt/vps-panel"))
        self.assertIn((["docker", "volume", "rm", "vps-panel_caddy_data"], None), self.e.calls)
        self.assertEqual(self.e.containers, [])
        self.assertNotIn("AAAA", self.e.text("/root/.ssh/authorized_keys"))
        self.assertIn("BBBB", self.e.text("/root/.ssh/authorized_keys"))

    def test_execution_requires_verified_connection(self):
        req = self.prepared()
        req.pop("localVerified")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(CleanupError, "проверенного SSH"):
                self.execute(req)
        self.assertTrue(self.e.exists("/etc/vps-agent"))
        self.assertTrue(self.e.exists(STATE_DIR + "/" + req["token"] + ".json"))

    def test_existing_firewall_script_blocks_before_removal(self):
        self.e.write("/usr/local/sbin/vps-portsync", "script")
        self.e.write("/usr/local/sbin/container-firewall", "foreign")
        with self.assertRaisesRegex(CleanupError, "согласуйте правила"):
            self.execute(self.prepared())
        self.assertTrue(self.e.exists("/etc/vps-agent"))
        self.assertEqual(self.e.text("/usr/local/sbin/container-firewall"), "foreign")

    def test_postgres_requires_separate_database_decision(self):
        self.e.write("/etc/default/x-ui", "XUI_DB_TYPE=postgres\n")
        with self.assertRaisesRegex(CleanupError, "PostgreSQL"):
            self.e.prepare(self.request(("xui",)))
        self.assertTrue(all(args[0] == 'getent' for args, _ in self.e.calls))

    def test_expired_or_changed_preparation_cannot_delete(self):
        req = self.prepared()
        self.e.rollback(req["token"])
        with self.assertRaisesRegex(CleanupError, "истекла"):
            self.execute(req)
        self.assertTrue(self.e.exists("/etc/vps-agent"))

    def test_second_prepare_rejected_and_no_secret_in_argv(self):
        self.e.prepare(self.request())
        with self.assertRaisesRegex(CleanupError, "уже выполняется"):
            self.e.prepare(self.request())
        for args, _ in self.e.calls:
            self.assertNotIn("new-root-password", " ".join(args))

    def test_only_acme_cron_removed(self):
        self.e.remove_cron("/root/.acme.sh/acme.sh")
        self.assertEqual(self.e.calls[-1][1], "0 0 * * * /usr/local/bin/own-backup\n")

    def test_detach_preserves_vpn_users_and_docker(self):
        self.e.write("/etc/vps-naive/users.json", "users")
        self.e.write("/etc/wdtt/passwords.json", "passwords")
        self.e.write("/etc/vps-agent/docker-installed", "")
        self.e.available.add("docker")
        req = {**self.request(), "ids": ["agent"], "detachOnly": True}
        req["token"] = self.e.prepare(req)["token"]
        self.execute(req)
        self.assertEqual(self.e.text("/etc/vps-naive/users.json"), "users")
        self.assertEqual(self.e.text("/etc/wdtt/passwords.json"), "passwords")
        self.assertFalse(any(args[0] == "apt-get" for args, _ in self.e.calls))
        self.assertFalse(self.e.exists("/etc/vps-agent"))
        self.assertNotIn("AAAA", self.e.text("/root/.ssh/authorized_keys"))

    def test_detach_cannot_select_vpn_service(self):
        self.e.write("/etc/vps-naive/users.json", "users")
        with self.assertRaisesRegex(CleanupError, "только агент"):
            self.e.prepare({**self.request(), "detachOnly": True})
        self.assertIn("old-hash", self.e.text("/etc/shadow"))

    def test_docker_with_unknown_containerd_storage_is_preserved(self):
        self.e.available.add("docker")
        self.e.write("/var/lib/containerd/foreign", "keep")
        with contextlib.redirect_stdout(io.StringIO()):
            self.e.maybe_remove_docker(True)
        self.assertEqual(self.e.text("/var/lib/containerd/foreign"), "keep")
        self.assertFalse(any(args[0] == "apt-get" for args, _ in self.e.calls))

    def test_unmodified_package_config_does_not_prevent_removing_unused_docker(self):
        self.e.available.update(("docker", "ctr"))
        self.e.write("/etc/containerd/config.toml", "default")
        self.e.write("/var/lib/containerd/own", "old-data")
        original = self.e.run
        def run(args, **kwargs):
            if args[0] == "dpkg-query":
                return subprocess.CompletedProcess(args, 0, " /etc/containerd/config.toml " + hashlib.md5(b"default").hexdigest() + "\n", "")
            return original(args, **kwargs)
        with patch.object(self.e, "run", side_effect=run):
            self.e.maybe_remove_docker(True)
        self.assertFalse(self.e.exists("/var/lib/containerd"))
        self.assertTrue(any(args[:3] == ["apt-get", "purge", "-y"] for args, _ in self.e.calls))

    def test_panel_cli_checks_peers_routes_and_pending_cascades(self):
        self.e.write("/opt/vps-panel/compose.yml", "compose")
        self.e.write("/opt/vps-panel/data/.keep", "")
        self.e.write("/etc/vps-agent/agent.json", '{"serverId":"panel"}')
        with sqlite3.connect(self.e.path("/opt/vps-panel/data/panel.db")) as db:
            db.executescript("""
                CREATE TABLE server(id TEXT, host TEXT, ssh_port INTEGER, agent_token_hash TEXT, registration_token TEXT);
                CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE vless_cascade(entry_server_id TEXT, exit_server_id TEXT);
                INSERT INTO server VALUES('panel','203.0.113.1',22,'panel-token',NULL);
                INSERT INTO server VALUES('peer','203.0.113.2',22,'peer-token',NULL);
            """)
        self.assertTrue(self.e.scan()["blockers"])
        with sqlite3.connect(self.e.path("/opt/vps-panel/data/panel.db")) as db:
            db.execute("UPDATE server SET agent_token_hash=NULL WHERE id='peer'")
            db.execute("INSERT INTO setting VALUES('uninstall_detached:peer','203.0.113.2:22')")
        self.assertFalse(self.e.scan()["blockers"])
        with sqlite3.connect(self.e.path("/opt/vps-panel/data/panel.db")) as db:
            db.execute("INSERT INTO setting VALUES('uninstall_cascades:panel','[{\"id\":\"pending\"}]')")
        self.assertTrue(self.e.scan()["blockers"])
        with sqlite3.connect(self.e.path("/opt/vps-panel/data/panel.db")) as db:
            db.execute("DELETE FROM setting WHERE key LIKE 'uninstall_cascades:%'")
            db.execute("INSERT INTO setting VALUES('xray_outbound','{\"serverId\":\"peer\"}')")
        self.assertTrue(self.e.scan()["blockers"])
        with sqlite3.connect(self.e.path("/opt/vps-panel/data/panel.db")) as db:
            db.execute("DELETE FROM setting WHERE key='xray_outbound'")
            db.execute("UPDATE server SET agent_token_hash='new-token' WHERE id='peer'")
        self.assertTrue(self.e.scan()["blockers"])


if __name__ == "__main__":
    unittest.main()
