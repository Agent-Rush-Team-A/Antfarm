"""Linux process tests against the immutable image supervisor and the #6 Bash argv."""

import base64
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


PACKAGE = Path(__file__).resolve().parents[2]
SUPERVISOR = Path("/opt/agentrush/sandbox-runner/supervisor.py")
WORKSPACE = Path("/workspace")
CLONE_HELPER = Path(__file__).with_name("clone-child")
# Read the owning wrapper rather than maintaining a second directory-validation implementation.
WRAPPER_SOURCE = re.search(r"const bashWrapper = `([^`]+)`", (PACKAGE / "src/server.ts").read_text()).group(1)
BASH_WRAPPER = WRAPPER_SOURCE.replace("\\\\", "\\")


def python_command(source):
    return shlex.join([sys.executable, "-I", "-B", "-c", source])


class Execution:
    def __init__(self, run_wait=5000, cleanup=2000, grace=250, execution_id=None):
        self.execution_id = execution_id or str(uuid.uuid4())
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(SUPERVISOR), "--execution-id", self.execution_id,
             "--run-wait-ms", str(run_wait), "--cleanup-timeout-ms", str(cleanup), "--term-grace-ms", str(grace)],
            cwd=WORKSPACE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        self.buffer = bytearray()
        self.diagnostics = bytearray()
        self.messages = []
        self.outputs = {"stdout": bytearray(), "stderr": bytearray()}

    def send_bytes(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def send(self, kind, **fields):
        self.send_bytes(json.dumps({"v": 1, "type": kind, "executionId": self.execution_id, **fields}).encode() + b"\n")

    def ready(self):
        message = self.read()
        if message != {"v": 1, "type": "ready", "executionId": self.execution_id}:
            raise AssertionError(message)
        return self

    def read(self, timeout=5):
        deadline = time.monotonic() + timeout
        while True:
            if b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                self.buffer = bytearray(rest)
                if len(line) > 16 * 1024:
                    raise AssertionError("Oversized supervisor output message")
                message = json.loads(line)
                if message["v"] != 1 or message["executionId"] != self.execution_id:
                    raise AssertionError(message)
                self.messages.append(message)
                if message["type"] == "output":
                    chunk = base64.b64decode(message["data"], validate=True)
                    if not 1 <= len(chunk) <= 8192:
                        raise AssertionError("Invalid output chunk length")
                    tail = self.outputs[message["stream"]]
                    tail.extend(chunk)
                    del tail[:-65536]
                return message
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("Timed out reading supervisor protocol")
            if not self.selector.get_map():
                raise EOFError(bytes(self.diagnostics).decode(errors="replace"))
            for key, _ in self.selector.select(remaining):
                chunk = os.read(key.fd, 16384)
                if not chunk:
                    self.selector.unregister(key.fileobj)
                elif key.data == "stderr":
                    self.diagnostics.extend(chunk)
                else:
                    self.buffer.extend(chunk)

    def run(self, command, workdir=".", remaining=5000):
        self.send("run", argv=["/bin/bash", "-p", "-c", BASH_WRAPPER, "sandbox-exec", workdir, command],
                  remainingMs=remaining)

    def finish(self):
        while True:
            message = self.read()
            if message["type"] == "finished":
                break
        if message["cleanup"] != "confirmed":
            raise AssertionError(message)
        self.process.wait(timeout=3)
        if self.process.returncode != 0:
            raise AssertionError(self.process.stderr.read())
        try:
            self.read(timeout=1)
        except EOFError:
            return message
        raise AssertionError("Protocol message after finished")

    def error(self):
        try:
            while True:
                self.read()
        except EOFError:
            pass
        self.process.wait(timeout=3)
        if self.process.returncode != 1 or any(message["type"] == "finished" for message in self.messages):
            raise AssertionError((self.process.returncode, self.messages))
        diagnostic = json.loads(self.diagnostics)
        if diagnostic["error"] != "supervisor_failed":
            raise AssertionError(diagnostic)
        return diagnostic

    def eof(self):
        self.process.stdin.close()
        self.process.stdin = None

    def close(self):
        if self.process.poll() is None:
            if self.process.stdin is not None:
                self.eof()
            try:
                self.process.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=2)
        self.selector.close()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="m1-", dir=WORKSPACE)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workdir = self.directory.name

    def execution(self, **options):
        execution = Execution(**options)
        self.addCleanup(execution.close)
        return execution.ready()

    def wait_file(self, path):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if path.exists() and path.stat().st_size:
                return path.read_text()
            time.sleep(0.005)
        self.fail(f"No readiness marker: {path}")

    def gone(self, pids):
        for pid in pids:
            self.assertFalse(Path(f"/proc/{pid}").exists(), f"Process {pid} survived cleanup")

    def tree(self, hold=False):
        directory = str(self.directory)
        return f"""
import os, signal, time
from pathlib import Path
directory = Path({directory!r})
(directory / 'main.pid').write_text(str(os.getpid()))
if os.fork():
    while not (directory / 'leaf.pid').exists():
        time.sleep(0.005)
    if not {hold!r}:
        os._exit(0)
else:
    os.setsid()
    (directory / 'middle.pid').write_text(str(os.getpid()))
    if os.fork():
        os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (directory / 'leaf.pid').write_text(str(os.getpid()))
while True:
    time.sleep(1)
"""

    def tree_pids(self):
        return [int(self.wait_file(self.directory / f"{name}.pid")) for name in ("main", "middle", "leaf")]

    def test_nonzero_result_output_isolation_stdin_and_descriptors(self):
        execution = self.execution()
        source = f"""
import json, os
assert os.read(0, 1) == b''
assert os.readlink('/proc/self/fd/0') == '/dev/null'
fds = []
for entry in os.listdir('/proc/self/fd'):
    try:
        os.readlink('/proc/self/fd/' + entry)
    except FileNotFoundError:
        continue
    fds.append(int(entry))
assert sorted(fds) == [0, 1, 2], fds
try:
    os.readlink('/proc/{execution.process.pid}/fd/0')
except PermissionError:
    pass
else:
    raise AssertionError('Supervisor control descriptor is readable')
os.write(1, b'{{"v":1,"type":"ready"}}\\n{{"type":"finished","cleanup":"confirmed"}}\\n')
os.write(2, 'warning 世界'.encode())
"""
        execution.run(python_command(source) + "; exit 7", self.workdir)
        result = execution.finish()
        self.assertEqual(result["reason"], "exited")
        self.assertEqual(result["bash"], {"exitCode": 7, "signal": None})
        self.assertEqual(execution.outputs["stdout"], b'{"v":1,"type":"ready"}\n{"type":"finished","cleanup":"confirmed"}\n')
        self.assertEqual(execution.outputs["stderr"].decode(), "warning 世界")
        self.assertEqual([message["type"] for message in execution.messages].count("ready"), 1)

    def test_normal_background_child_is_reaped_and_bash_status_preserved(self):
        execution = self.execution()
        execution.run("sleep 60 & printf '%s' $! > background.pid; exit 3", self.workdir)
        result = execution.finish()
        pid = int(self.wait_file(self.directory / "background.pid"))
        self.assertEqual(result["bash"], {"exitCode": 3, "signal": None})
        self.gone([pid])

    def test_double_fork_setsid_and_ignored_sigterm(self):
        execution = self.execution()
        execution.run(python_command(self.tree()) + "; exit 3", self.workdir)
        result = execution.finish()
        pids = self.tree_pids()
        self.assertEqual(result["bash"], {"exitCode": 3, "signal": None})
        self.gone(pids)
        print(json.dumps({"case": "double-fork-setsid", "pidsAbsent": pids, "finished": result}), flush=True)

    def test_cancel_and_timeout_leave_parallel_execution_alive(self):
        for reason in ("cancelled", "timeout"):
            with self.subTest(reason=reason):
                b = self.execution()
                b.run("while [[ ! -e release ]]; do printf x >> progress; sleep 0.02; done; exit 7", self.workdir)
                self.wait_file(self.directory / "progress")
                a = self.execution()
                a.run("exec " + python_command(self.tree(hold=True)), self.workdir, remaining=1000)
                pids = self.tree_pids()
                if reason == "cancelled":
                    a.send("cancel", reason="cancelled")
                    a.send("cancel", reason="shutdown")
                result = a.finish()
                self.assertEqual(result["reason"], reason)
                self.gone(pids)
                before = (self.directory / "progress").stat().st_size
                deadline = time.monotonic() + 2
                while (self.directory / "progress").stat().st_size <= before and time.monotonic() < deadline:
                    time.sleep(0.005)
                self.assertGreater((self.directory / "progress").stat().st_size, before)
                self.assertIsNone(b.process.poll())
                (self.directory / "release").touch()
                b_result = b.finish()
                self.assertEqual(b_result["bash"], {"exitCode": 7, "signal": None})
                print(json.dumps({"case": reason, "pidsAbsent": pids, "A": result, "B": b_result}), flush=True)
                for path in self.directory.iterdir():
                    path.unlink()

    def test_cancel_before_run_has_no_bash_result(self):
        execution = self.execution()
        execution.send("cancel", reason="cancelled")
        result = execution.finish()
        self.assertEqual(result["reason"], "cancelled")
        self.assertIsNone(result["bash"])

    def test_control_eof_before_and_after_run(self):
        for started in (False, True):
            with self.subTest(started=started):
                execution = self.execution()
                if started:
                    execution.run("exec " + python_command(self.tree(hold=True)), self.workdir)
                    pids = self.tree_pids()
                execution.eof()
                result = execution.finish()
                self.assertEqual(result["reason"], "control_eof")
                if started:
                    self.gone(pids)
                else:
                    self.assertIsNone(result["bash"])

    def test_timeout_reason_survives_bash_trapping_term_and_exiting_zero(self):
        execution = self.execution()
        execution.run("trap 'exit 0' TERM; printf ready > ready; while :; do :; done", self.workdir, remaining=200)
        self.wait_file(self.directory / "ready")
        result = execution.finish()
        self.assertEqual(result["reason"], "timeout")
        self.assertEqual(result["bash"], {"exitCode": 0, "signal": None})

    def test_bash_signal_is_distinct_from_supervisor_exit(self):
        execution = self.execution()
        execution.run("kill -TERM $$", self.workdir)
        result = execution.finish()
        self.assertEqual(result["reason"], "exited")
        self.assertEqual(result["bash"], {"exitCode": None, "signal": signal.SIGTERM})

    def test_sigterm_grace_escalates_to_kill(self):
        execution = self.execution()
        source = "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open('ready','w').write(str(os.getpid())); time.sleep(60)"
        execution.run("exec " + python_command(source), self.workdir)
        pid = int(self.wait_file(self.directory / "ready"))
        started = time.monotonic()
        execution.send("cancel", reason="cancelled")
        result = execution.finish()
        self.assertGreaterEqual(time.monotonic() - started, 0.20)
        self.assertEqual(result["bash"], {"exitCode": None, "signal": signal.SIGKILL})
        self.gone([pid])

    def test_clone_child_with_no_sigchld_is_adopted_and_reaped(self):
        self.assertTrue(CLONE_HELPER.is_file(), "Compile clone_child.c to tests/supervisor/clone-child before running")
        execution = self.execution()
        child = self.directory / "clone.pid"
        parent = self.directory / "parent.pid"
        release = self.directory / "release"
        execution.run("exec " + shlex.join([str(CLONE_HELPER), str(child), str(parent), str(release)]), self.workdir)
        pid = int(self.wait_file(child))
        parent_pid = int(self.wait_file(parent))
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        self.assertEqual(int(fields[1]), parent_pid)
        self.assertEqual(int(fields[35]), 0)
        release.touch()
        result = execution.finish()
        self.assertEqual(result["bash"], {"exitCode": 3, "signal": None})
        self.gone([pid, parent_pid])
        print(json.dumps({"case": "clone-exit-signal-0", "pidsAbsent": [pid, parent_pid], "finished": result}), flush=True)

    def test_fragmented_run_and_utf16_execution_id(self):
        execution = self.execution(execution_id="😀" * 64)
        request = json.dumps({"v": 1, "type": "run", "executionId": execution.execution_id,
                              "argv": ["/bin/bash", "-p", "-c", BASH_WRAPPER, "sandbox-exec", self.workdir,
                                       "printf 世界; exit 9"], "remainingMs": 5000}, ensure_ascii=False).encode() + b"\n"
        for index in range(0, len(request), 17):
            execution.send_bytes(request[index:index + 17])
        result = execution.finish()
        self.assertEqual(result["bash"], {"exitCode": 9, "signal": None})
        self.assertEqual(execution.outputs["stdout"].decode(), "世界")

    def test_exact_run_byte_limit(self):
        execution = self.execution()
        request = json.dumps({"v": 1, "type": "run", "executionId": execution.execution_id,
                              "argv": ["/bin/bash", "-p", "-c", "exit 4"], "remainingMs": 5000}).encode()
        execution.send_bytes(request + b" " * (128 * 1024 - len(request)) + b"\n")
        self.assertEqual(execution.finish()["bash"], {"exitCode": 4, "signal": None})

    def test_invalid_protocol_never_reports_finished_and_cleans_started_children(self):
        invalid = [b"not JSON\n", b"\xff\n", b" " * (128 * 1024 + 1)]
        for data in invalid:
            with self.subTest(data=data[:10]):
                execution = self.execution()
                execution.run("exec " + python_command(self.tree(hold=True)), self.workdir)
                pids = self.tree_pids()
                execution.send_bytes(data)
                execution.error()
                self.gone(pids)
                for path in self.directory.iterdir():
                    path.unlink()

    def test_invalid_fields_and_cancel_size_are_rejected_before_run(self):
        for change in ({"v": True}, {"executionId": "other"}, {"reason": "invalid"}, {"extra": 1}):
            with self.subTest(change=change):
                execution = self.execution()
                message = {"v": 1, "type": "cancel", "executionId": execution.execution_id, "reason": "cancelled", **change}
                execution.send_bytes(json.dumps(message).encode() + b"\n")
                execution.error()
        execution = self.execution()
        message = json.dumps({"v": 1, "type": "cancel", "executionId": execution.execution_id, "reason": "cancelled"}).encode()
        execution.send_bytes(message + b" " * (16 * 1024 + 1 - len(message)) + b"\n")
        execution.error()

    def test_duplicate_run_is_not_executed_twice(self):
        execution = self.execution()
        command = "printf x >> effects; printf ready > ready; sleep 60"
        execution.run(command, self.workdir)
        self.wait_file(self.directory / "ready")
        execution.run(command, self.workdir)
        execution.error()
        self.assertEqual((self.directory / "effects").read_text(), "x")

    def test_run_wait_expiry_and_partial_control_eof_fail(self):
        execution = self.execution(run_wait=100)
        self.assertIn("waiting for run", execution.error()["message"])
        execution = self.execution()
        execution.send_bytes(b'{"v":1')
        execution.eof()
        self.assertIn("Incomplete", execution.error()["message"])

    def test_output_backpressure_retains_each_tail_and_truncation_flag(self):
        execution = self.execution()
        source = """
import os
for _ in range(256):
    os.write(1, b'x' * 8192)
    os.write(2, b'y' * 8192)
os.write(1, b'OUT-END')
os.write(2, b'ERR-END')
open('produced', 'w').write('ready')
"""
        execution.run(python_command(source) + "; exit 7", self.workdir)
        self.wait_file(self.directory / "produced")
        result = execution.finish()
        self.assertEqual(result["bash"], {"exitCode": 7, "signal": None})
        self.assertEqual(result["outputTruncated"], {"stdout": True, "stderr": True})
        self.assertEqual(execution.outputs["stdout"], b"x" * (65536 - 7) + b"OUT-END")
        self.assertEqual(execution.outputs["stderr"], b"y" * (65536 - 7) + b"ERR-END")

    def test_unread_output_does_not_block_cancel_or_process_cleanup(self):
        source = """
import os
open('flood.pid', 'w').write(str(os.getpid()))
for _ in range(256):
    os.write(1, b'x' * 8192)
open('produced', 'w').write('ready')
while True:
    os.write(1, b'x' * 8192)
"""
        for reason in ("cancelled", "timeout"):
            with self.subTest(reason=reason):
                execution = self.execution(cleanup=500, grace=100)
                execution.run("exec " + python_command(source), self.workdir, remaining=500)
                pid = int(self.wait_file(self.directory / "flood.pid"))
                self.wait_file(self.directory / "produced")
                if reason == "cancelled":
                    execution.send("cancel", reason="cancelled")
                execution.process.wait(timeout=3)
                self.gone([pid])
                diagnostic = execution.error()
                self.assertIn("budget", diagnostic["message"])
                for path in self.directory.iterdir():
                    path.unlink()

    def test_closed_protocol_output_still_cleans_children(self):
        execution = self.execution()
        execution.run("exec " + python_command(self.tree(hold=True)), self.workdir)
        pids = self.tree_pids()
        execution.selector.unregister(execution.process.stdout)
        execution.process.stdout.close()
        execution.eof()
        execution.error()
        self.gone(pids)

    def test_production_workdir_validation_rejects_symlink_escape(self):
        nested = self.directory / "nested"
        nested.mkdir()
        execution = self.execution()
        execution.run("pwd -P; printf ok > result", f"{self.workdir}/nested")
        self.assertEqual(execution.finish()["bash"], {"exitCode": 0, "signal": None})
        self.assertEqual(execution.outputs["stdout"].decode().strip(), str(nested))
        self.assertEqual((nested / "result").read_text(), "ok")
        (self.directory / "escape").symlink_to("/tmp", target_is_directory=True)
        execution = self.execution()
        execution.run("printf unexpected", f"{self.workdir}/escape")
        self.assertEqual(execution.finish()["bash"], {"exitCode": 125, "signal": None})
        self.assertEqual(execution.outputs["stdout"], b"")
        self.assertIn(b"Cannot use the requested working directory", execution.outputs["stderr"])

    def test_image_supervisor_is_root_owned_and_readonly(self):
        self.assertNotEqual(os.getuid(), 0)
        self.assertEqual(SUPERVISOR.stat().st_uid, 0)
        self.assertEqual(SUPERVISOR.stat().st_mode & 0o777, 0o444)
        self.assertEqual(SUPERVISOR.parent.stat().st_mode & 0o777, 0o555)
        with self.assertRaises(OSError):
            with SUPERVISOR.open("ab"):
                self.fail("Supervisor program is writable")


if __name__ == "__main__":
    unittest.main()
