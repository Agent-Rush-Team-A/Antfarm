"""Supervise one Linux execution; only ECHILD and drained output permit finished."""

import argparse
import base64
import ctypes
import errno
import json
import os
import selectors
import signal
import sys
import time


RUN_LIMIT = 128 * 1024
MESSAGE_LIMIT = 16 * 1024
TAIL_LIMIT = 64 * 1024
OUTPUT_CHUNK = 8192
WAIT_ALL = 0x40000000  # Linux __WALL includes children whose exit signal is not SIGCHLD.


class SupervisionError(Exception):
    """The Runner must recycle the container rather than trust an execution result."""


def argument_text(value):
    if not isinstance(value, str) or "\0" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeError:
        return False
    return True


def initialize():
    if sys.platform != "linux" or os.getuid() == 0 or os.geteuid() == 0:
        raise SupervisionError("Linux and a non-root identity are required")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise SupervisionError("pidfd_open and pidfd_send_signal are required")
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    for operation, value in ((36, 1), (4, 0)):
        if prctl(operation, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot initialize subreaper or dumpable")
    subreaper = ctypes.c_int()
    if (prctl(37, ctypes.addressof(subreaper), 0, 0, 0) != 0
            or subreaper.value != 1 or prctl(3, 0, 0, 0, 0) != 0):
        raise SupervisionError("Cannot confirm subreaper and dumpable settings")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    with open(f"/proc/self/task/{os.getpid()}/children", encoding="ascii") as children:
        if children.read().strip():
            raise SupervisionError("Supervisor must start without children")


class Supervisor:
    def __init__(self, options):
        self.options = options
        self.selector = selectors.DefaultSelector()
        self.control = bytearray()
        self.pipes = {}
        self.pending = {"stdout": bytearray(), "stderr": bytearray()}
        self.truncated = {"stdout": False, "stderr": False}
        self.pidfds = {}
        self.bash_pid = None
        self.bash = None
        self.reason = None
        self.failure = None
        self.deadline = time.monotonic() + options.run_wait_ms / 1000
        self.cleanup_deadline = None
        self.term_deadline = None
        self.no_children = False
        self.finished = False
        self.active = self.encode("ready")
        self.writing = False
        self.output_open = True
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        self.selector.register(0, selectors.EVENT_READ, "control")
        self.watch_output()

    def encode(self, kind, **fields):
        message = {"v": 1, "type": kind, "executionId": self.options.execution_id, **fields}
        encoded = json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        if len(encoded) > MESSAGE_LIMIT:
            raise SupervisionError("Outgoing protocol message exceeds its byte limit")
        return encoded + b"\n"

    def watch_output(self):
        wanted = self.output_open and (bool(self.active) or any(self.pending.values()))
        if wanted and not self.writing:
            self.selector.register(1, selectors.EVENT_WRITE, "protocol")
        elif not wanted and self.writing:
            self.selector.unregister(1)
        self.writing = wanted

    def begin_cleanup(self, reason):
        if self.reason is None:
            self.reason = reason
            now = time.monotonic()
            self.cleanup_deadline = now + self.options.cleanup_timeout_ms / 1000
            self.term_deadline = now + self.options.term_grace_ms / 1000

    def fail(self, error):
        if self.failure is None:
            self.failure = error
        self.begin_cleanup("failed")
        if 0 in self.selector.get_map():
            self.selector.unregister(0)

    def receive(self):
        chunk = os.read(0, OUTPUT_CHUNK)
        if not chunk:
            self.selector.unregister(0)
            if self.control:
                raise SupervisionError("Incomplete control message at EOF")
            self.begin_cleanup("control_eof")
            return
        self.control.extend(chunk)
        while b"\n" in self.control:
            line, _, rest = self.control.partition(b"\n")
            self.control = bytearray(rest)
            if len(line) > RUN_LIMIT:
                raise SupervisionError("Control message exceeds its byte limit")
            try:
                message = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeError, RecursionError) as error:
                raise SupervisionError("Invalid UTF-8 JSON control message") from error
            self.accept(message, len(line))
        if len(self.control) > RUN_LIMIT:
            raise SupervisionError("Unterminated control message exceeds its byte limit")

    def accept(self, message, size):
        if (not isinstance(message, dict) or type(message.get("v")) is not int
                or message["v"] != 1 or message.get("executionId") != self.options.execution_id):
            raise SupervisionError("Control message has an invalid version or execution ID")
        common = {"v", "type", "executionId"}
        if message.get("type") == "cancel":
            if (set(message) != common | {"reason"} or size > MESSAGE_LIMIT
                    or message["reason"] not in ("cancelled", "timeout", "shutdown")):
                raise SupervisionError("Invalid cancel message")
            self.begin_cleanup(message["reason"])
        elif message.get("type") == "run":
            if self.bash_pid is not None or self.reason is not None:
                raise SupervisionError("Run may only be accepted once, before cleanup")
            argv = message.get("argv")
            remaining = message.get("remainingMs")
            if (set(message) != common | {"argv", "remainingMs"}
                    or not isinstance(argv, list) or not argv or not argv[0]
                    or not all(argument_text(value) for value in argv)
                    or type(remaining) is not int or not 1 <= remaining <= 60000):
                raise SupervisionError("Invalid run arguments or remaining budget")
            self.deadline = time.monotonic() + remaining / 1000
            self.spawn(argv)
        else:
            raise SupervisionError("Unexpected control message type")

    def spawn(self, argv):
        descriptors = []
        try:
            for _ in range(2):
                descriptors.extend(os.pipe2(os.O_CLOEXEC))
            pid = os.fork()
        except OSError:
            for fd in descriptors:
                os.close(fd)
            raise
        if pid == 0:
            try:
                with open(os.devnull, "rb", buffering=0) as stdin:
                    os.dup2(stdin.fileno(), 0)
                os.dup2(descriptors[1], 1)
                os.dup2(descriptors[3], 2)
                for entry in os.listdir("/proc/self/fd"):
                    fd = int(entry)
                    if fd > 2:
                        try:
                            os.close(fd)
                        except OSError as error:
                            if error.errno != errno.EBADF:
                                raise
                signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                os.execv(argv[0], argv)
            except (OSError, ValueError):
                os.write(2, b"Cannot execute the requested command\n")
            finally:
                os._exit(127)
        self.bash_pid = pid
        for fd, stream in ((descriptors[0], "stdout"), (descriptors[2], "stderr")):
            os.set_blocking(fd, False)
            self.pipes[fd] = stream
            self.selector.register(fd, selectors.EVENT_READ, stream)
        os.close(descriptors[1])
        os.close(descriptors[3])

    def reap(self):
        # Bounded work keeps fork-heavy commands from starving control input and deadlines.
        for _ in range(64):
            try:
                pid, status = os.waitpid(-1, os.WNOHANG | WAIT_ALL)
            except ChildProcessError:
                self.no_children = True
                if self.bash_pid is not None and self.bash is None:
                    raise SupervisionError("Bash wait status is missing")
                return
            if pid == 0:
                self.no_children = False
                return
            tracked = self.pidfds.pop(pid, None)
            if tracked is not None:
                os.close(tracked[0])
            if pid == self.bash_pid:
                if os.WIFEXITED(status):
                    self.bash = {"exitCode": os.WEXITSTATUS(status), "signal": None}
                elif os.WIFSIGNALED(status):
                    self.bash = {"exitCode": None, "signal": os.WTERMSIG(status)}
                else:
                    raise SupervisionError("Unexpected Bash wait status")
                self.begin_cleanup("exited")
        self.no_children = False

    def signal_children(self):
        with open(f"/proc/self/task/{os.getpid()}/children", encoding="ascii") as children:
            pids = [int(value) for value in children.read().split()]
        wanted = signal.SIGKILL if time.monotonic() >= self.term_deadline else signal.SIGTERM
        # No wait occurs between enumerating actual children and pinning/signalling them.
        for pid in pids:
            fd, sent = self.pidfds.get(pid, (None, None))
            if fd is None:
                fd = os.pidfd_open(pid)
                self.pidfds[pid] = (fd, None)
            if sent != wanted:
                try:
                    signal.pidfd_send_signal(fd, wanted)
                except ProcessLookupError:
                    pass  # An exited child is still owned until wait reaps it.
                self.pidfds[pid] = (fd, wanted)

    def read_output(self, fd):
        chunk = os.read(fd, OUTPUT_CHUNK)
        stream = self.pipes[fd]
        if not chunk:
            self.selector.unregister(fd)
            del self.pipes[fd]
            os.close(fd)
            return
        if self.output_open:
            pending = self.pending[stream]
            pending.extend(chunk)
            if len(pending) > TAIL_LIMIT:
                del pending[:-TAIL_LIMIT]
                self.truncated[stream] = True

    def write_output(self):
        if not self.active:
            for stream, pending in self.pending.items():
                if pending:
                    data = bytes(pending[:OUTPUT_CHUNK])
                    del pending[:OUTPUT_CHUNK]
                    self.active = self.encode("output", stream=stream, data=base64.b64encode(data).decode("ascii"))
                    break
        try:
            written = os.write(1, self.active)
        except BlockingIOError:
            return
        except BrokenPipeError as error:
            self.output_open = False
            self.active = b""
            for pending in self.pending.values():
                pending.clear()
            self.fail(SupervisionError("Protocol output closed before confirmation"))
            return
        self.active = self.active[written:]

    def run(self):
        while True:
            self.reap()
            now = time.monotonic()
            if self.reason is None and now >= self.deadline:
                if self.bash_pid is None:
                    raise SupervisionError("Timed out waiting for run")
                self.begin_cleanup("timeout")
            if self.reason is not None:
                if now >= self.cleanup_deadline:
                    raise SupervisionError("Cleanup or protocol drain exceeded its budget")
                if not self.no_children:
                    self.signal_children()
                elif not self.pipes and not self.active and not any(self.pending.values()):
                    if self.failure is not None:
                        raise self.failure
                    if self.finished:
                        return
                    self.active = self.encode("finished", reason=self.reason, bash=self.bash,
                                              cleanup="confirmed", outputTruncated=self.truncated)
                    self.finished = True
            self.watch_output()
            until = self.cleanup_deadline if self.reason is not None else self.deadline
            wait = min(0.01, max(0, until - time.monotonic()))
            for key, _ in self.selector.select(wait):
                try:
                    if key.data == "control":
                        self.receive()
                    elif key.data == "protocol":
                        self.write_output()
                    else:
                        self.read_output(key.fd)
                except BlockingIOError:
                    continue
                except (SupervisionError, OSError) as error:
                    self.fail(error)

    def close(self):
        for fd in self.pipes:
            os.close(fd)
        for fd, _ in self.pidfds.values():
            os.close(fd)
        self.selector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution-id", required=True)
    parser.add_argument("--run-wait-ms", required=True, type=int)
    parser.add_argument("--cleanup-timeout-ms", required=True, type=int)
    parser.add_argument("--term-grace-ms", required=True, type=int)
    options = parser.parse_args()
    if (not argument_text(options.execution_id)
            or not 1 <= len(options.execution_id.encode("utf-16-le")) // 2 <= 128
            or not 1 <= options.run_wait_ms <= 2147483647
            or not 1 <= options.cleanup_timeout_ms <= 60000
            or not 0 <= options.term_grace_ms < options.cleanup_timeout_ms):
        parser.error("Invalid execution ID, run wait, cleanup budget or SIGTERM grace")
    supervisor = None
    try:
        initialize()
        supervisor = Supervisor(options)
        supervisor.run()
        return 0
    except (SupervisionError, OSError) as error:
        diagnostic = json.dumps({"error": "supervisor_failed", "message": str(error), "cleanup": "unconfirmed"})
        os.set_blocking(2, False)
        try:
            os.write(2, (diagnostic + "\n").encode("utf-8"))
        except OSError:
            pass  # A failed diagnostic transport must not hide the nonzero supervisor exit.
        return 1
    finally:
        if supervisor is not None:
            supervisor.close()


if __name__ == "__main__":
    sys.exit(main())
