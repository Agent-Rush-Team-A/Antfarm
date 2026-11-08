import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from pair import operate

HARNESS = "10000000-0000-4000-8000-000000000001"
RUNNER = "10000000-0000-4000-8000-000000000002"
CONFIG = {
    "region": "nrt",
    "deployment": "antfarm-local-test",
    "harness": {"id": HARNESS, "label": "antfarm-test-web", "ssh": "web"},
    "runner": {"id": RUNNER, "label": "antfarm-test-runner", "ssh": "runner"},
}


class PairTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.states = {
            host["id"]: {"id": host["id"], "label": host["label"], "region": CONFIG["region"],
                         "power_status": "stopped"}
            for host in (CONFIG["harness"], CONFIG["runner"])
        }

    def api(self, method, path):
        instance_id = path.split("/")[2]
        if method == "GET":
            return {"instance": self.states[instance_id]}
        action = path.split("/")[3]
        self.events.append((action, instance_id))
        self.states[instance_id]["power_status"] = {"start": "running", "halt": "stopped"}[action]

    def ssh(self, alias, *command):
        self.events.append((alias, *command))

    def test_start_runner_before_harness(self):
        operate("start", CONFIG, self.api, self.ssh)
        self.assertEqual(self.events, [
            ("start", RUNNER), ("runner", "runner-start"),
            ("start", HARNESS), ("web", "harness-start"),
        ])

    def test_stop_web_then_confirm_runner_cleanup_before_poweroff(self):
        for state in self.states.values():
            state["power_status"] = "running"
        operate("stop", CONFIG, self.api, self.ssh)
        self.assertEqual(self.events, [
            ("web", "harness-stop"), ("runner", "runner-stop", "antfarm-local-test"),
            ("halt", RUNNER), ("halt", HARNESS),
        ])

    def test_bad_label_prevents_any_mutation(self):
        self.states[HARNESS]["label"] = "another-deployment"
        with self.assertRaisesRegex(ValueError, "identity"):
            operate("start", CONFIG, self.api, self.ssh)
        self.assertEqual(self.events, [])

    def test_unknown_power_state_prevents_any_mutation(self):
        self.states[RUNNER]["power_status"] = "unknown"
        with self.assertRaisesRegex(ValueError, "power state"):
            operate("stop", CONFIG, self.api, self.ssh)
        self.assertEqual(self.events, [])

    def test_runner_start_failure_blocks_harness_start(self):
        def failed(*command):
            self.ssh(*command)
            raise OSError("Runner status unavailable")

        with self.assertRaises(OSError):
            operate("start", CONFIG, self.api, failed)
        self.assertEqual(self.events, [("start", RUNNER), ("runner", "runner-start")])

    def test_uncertain_runner_cleanup_blocks_poweroff(self):
        for state in self.states.values():
            state["power_status"] = "running"

        def failed(alias, *command):
            self.ssh(alias, *command)
            if alias == "runner":
                raise OSError("Close result unknown")

        with self.assertRaises(OSError):
            operate("stop", CONFIG, self.api, failed)
        self.assertEqual(self.events, [
            ("web", "harness-stop"), ("runner", "runner-stop", "antfarm-local-test"),
        ])

    def test_already_stopped_pair_needs_no_ssh(self):
        operate("stop", CONFIG, self.api, self.ssh)
        self.assertEqual(self.events, [])


@unittest.skipUnless(os.name == "posix", "Requires Bash and Linux utilities")
class MountTests(unittest.TestCase):
    def test_web_uses_the_checked_mount_and_tunnel(self):
        control = Path(__file__).resolve().with_name("host-control.sh")
        workspace_root = "/srv/antfarm/docker/workspaces"
        for root, socket_path, accepted in [
            (workspace_root, "/run/antfarm-runner-tunnel/runner.sock", True),
            (workspace_root, "/run/agentrush-sandbox/runner.sock", False),
            ("/var/lib/agentrush-workspaces", "/run/antfarm-runner-tunnel/runner.sock", False),
        ]:
            with self.subTest(root=root, socket_path=socket_path):
                result = subprocess.run(
                    ["bash", str(control), "harness-check"],
                    env={**os.environ, "DSH_MULTIUSER_WORKSPACE_ROOT": workspace_root,
                         "DSH_DOCKER_MODES_CONFIG_JSON": json.dumps(
                             {"workspaceRoot": root, "socketPath": socket_path,
                              "drainSocket": "/run/antfarm-docker-web/drain.sock"},
                         )},
                    capture_output=True,
                )
                self.assertEqual(result.returncode == 0, accepted, result.stderr)

    def test_only_matching_vfs_is_accepted(self):
        check_mount = Path(__file__).resolve().parents[1] / "vfs" / "check-mount.sh"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            mount = root / "vfs"
            workspace = mount / "workspaces"
            workspace.mkdir(parents=True)
            mock = root / "findmnt"
            mock.write_text(
                '#!/bin/sh\n'
                '[ -n "$MOUNT_FACTS" ] || exit 1\n'
                'shift\n'
                'case "$1" in\n'
                '  --mountpoint) printf "%s\\n" "$MOUNT_FACTS";;\n'
                '  --target) printf "%s %s\\n" "$TARGET" "$MOUNT_FACTS";;\n'
                'esac\n', encoding="utf-8",
            )
            mock.chmod(0o755)
            for facts, target, accepted in [
                ("123 virtiofs /", mount, True),
                ("", mount, False),
                ("456 virtiofs /", mount, False),
                ("123 virtiofs /another", mount, False),
                ("123 ext4 /", mount, False),
                ("123 virtiofs /", workspace, False),
            ]:
                with self.subTest(facts=facts, target=target):
                    result = subprocess.run(
                        ["bash", str(check_mount), str(mount), "123", "/", str(workspace), "read-write"],
                        env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                             "MOUNT_FACTS": facts, "TARGET": str(target)},
                        text=True, capture_output=True,
                    )
                    self.assertEqual(result.returncode == 0, accepted, result.stderr)
                    self.assertEqual(list(workspace.iterdir()), [])


@unittest.skipUnless(os.name == "posix", "Requires Bash and Linux utilities")
class HostControlTests(unittest.TestCase):
    def test_harness_start_checks_mode_readiness_even_if_web_is_already_active(self):
        control = Path(__file__).resolve().with_name("host-control.sh")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            commands = {
                "systemctl": '[ "$*" = "start antfarm-docker-web.service" ]\n',
                "curl": 'test "${@: -3:1}" = --unix-socket && '\
                        'test "${@: -2:1}" = /run/antfarm-docker-web/drain.sock && '\
                        'test "${@: -1}" = http://localhost/ready && exit "$READINESS_STATUS"\n',
            }
            for name, body in commands.items():
                path = directory / name
                path.write_text("#!/bin/bash\n" + body, encoding="utf-8")
                path.chmod(0o755)
            for status in (0, 22):
                with self.subTest(readiness_status=status):
                    result = subprocess.run(
                        ["bash", str(control), "harness-start"],
                        env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                             "READINESS_STATUS": str(status)},
                        capture_output=True,
                    )
                    self.assertEqual(result.returncode, status, result.stderr)

    def test_unconfirmed_web_drain_does_not_stop_services(self):
        control = Path(__file__).resolve().with_name("host-control.sh")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            commands = {
                "systemctl": '[ "$1" = is-active ] || touch "$FIXTURE/stopped"\n',
                "curl": 'exit 28\n',
            }
            for name, body in commands.items():
                path = directory / name
                path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", str(control), "harness-stop"],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "FIXTURE": temporary},
                capture_output=True,
            )
            self.assertEqual(result.returncode, 28, result.stderr)
            self.assertFalse((directory / "stopped").exists())

    def test_runner_stop_requires_confirmed_inventory_after_delete(self):
        control = Path(__file__).resolve().with_name("host-control.sh")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            commands = {
                "sed": 'printf "%s\\n" antfarm-local-test\n',
                "docker": 'if [ -f "$FIXTURE/closed" ]; then exit "$INVENTORY_STATUS"; fi\nprintf "%s\\n" ws-a\n',
                "curl": 'touch "$FIXTURE/closed"\n',
                "systemctl": 'case "$1" in stop) echo "$*" >> "$FIXTURE/stopped" ;; show) echo success ;; esac\n',
                "sync": 'echo sync >> "$FIXTURE/stopped"\n',
            }
            for name, body in commands.items():
                path = directory / name
                path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
                path.chmod(0o755)
            for status in (5, 0):
                with self.subTest(inventory_status=status):
                    (directory / "closed").unlink(missing_ok=True)
                    result = subprocess.run(
                        ["bash", str(control), "runner-stop", "antfarm-local-test"],
                        env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                             "FIXTURE": temporary, "INVENTORY_STATUS": str(status)},
                        capture_output=True,
                    )
                    self.assertEqual(result.returncode, status, result.stderr)
                    self.assertTrue((directory / "closed").is_file())
                    stopped = directory / "stopped"
                    if status == 0:
                        self.assertEqual(stopped.read_text().splitlines(), [
                            "stop antfarm-docker-runner.service", "stop docker.service docker.socket", "sync",
                        ])
                    else:
                        self.assertFalse(stopped.exists())


if __name__ == "__main__":
    unittest.main()
