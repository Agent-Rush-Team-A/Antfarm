# Execution supervisor image

English | [中文](README.zh.md)

Run one command and clean its descendants without signalling another execution in the same container. The Python supervisor owns its command's process tree, preserves the original command status, and reports completion only after Linux confirms that it has no children. Runner Exec starts this supervisor and exchanges its control protocol over a dedicated Docker Upgrade connection.

## Build and launch

Build [image/Dockerfile](../image/Dockerfile) with this package directory as the Docker context. The base image is pinned by digest and supplies Python 3.11, Bash and sleep. The supervisor resides at `/opt/agentrush/sandbox-runner/supervisor.py`, owned by root with mode `0444` in a `0555` directory. Pin the resulting image by its own digest, rather than the base image digest.

Use the existing Runner container limits: non-root numeric UID/GID, no network, read-only root, all capabilities dropped, no-new-privileges, 1 CPU, 512 MiB memory without swap, 64 PIDs, a 32 MiB `/tmp`, and one writable workspace bind at `/workspace`. The image defaults to UID/GID `10001:10001` and `/usr/bin/sleep infinity`. Docker Exec must have no TTY and must attach stdin, stdout and stderr.

Start `/usr/local/bin/python3 -I -B /opt/agentrush/sandbox-runner/supervisor.py` with four required arguments: `--execution-id`, `--run-wait-ms`, `--cleanup-timeout-ms` and `--term-grace-ms`. The execution ID is well-formed Unicode without NUL, containing 1–128 UTF-16 code units. Run wait accepts 1–2147483647 milliseconds; cleanup accepts 1–60000; TERM grace accepts zero or a positive integer smaller than cleanup. The Runner supplies its requestTimeoutMs, cleanupTimeoutMs and termGraceMs deployment values; the script requires explicit arguments.

Initialization requires Linux, non-root identity, subreaper and non-dumpable settings, pidfd open/signal support, and readable process-child information in `/proc`. Failure produces no ready message and starts no user code. User stdin is `/dev/null`; stdout and stderr enter separate supervisor pipes. The child closes inherited control, protocol, selector and other descriptors before exec.

Pass the execution ID as a single argv value, `--execution-id=<value>`, so leading hyphens and embedded equals signs remain data.

## Protocol reference

Each message is one UTF-8 JSON object followed by LF, without BOM. Common fields are `v: 1`, `type` and the exact `executionId`. Unknown fields, invalid types, wrong IDs and wrong versions fail the protocol. Run messages accept at most 128 KiB before LF; other messages accept at most 16 KiB. An incomplete input line is bounded by the 128 KiB maximum, and its type-specific limit is checked when the line is complete.

| Message | Direction | Additional fields |
| --- | --- | --- |
| `ready` | Supervisor → caller | None. Initialization succeeded; user code has not started. |
| `run` | Caller → supervisor | `argv`: nonempty string array with a nonempty executable and well-formed, NUL-free arguments; `remainingMs`: integer 1–60000. Send once after ready, with the existing Runner's normalized Bash wrapper argv. |
| `cancel` | Caller → supervisor | `reason`: `cancelled`, `timeout` or `shutdown`. Cancellation before run starts no command. Repeated cancellation preserves the first accepted reason. |
| `output` | Supervisor → caller | `stream`: `stdout` or `stderr`; `data`: padded base64 encoding of 1–8192 original bytes. Each stream retains its own ordering. |
| `finished` | Supervisor → caller | `reason`: `exited`, `timeout`, `cancelled`, `shutdown` or `control_eof`; `bash`: command status described below; `cleanup: "confirmed"`; `outputTruncated`: separate stdout/stderr booleans. |

`bash` is `{exitCode: 0..255, signal: null}` for an ordinary exit, `{exitCode: null, signal: 1..64}` for a signal exit, or null when no command started. A missing wait status for a started command is a failure, never null or exit code zero. A command that traps TERM and exits zero can still have reason timeout or cancelled. Command status and supervisor exit code describe separate outcomes.

Supervisor stdout carries only protocol messages; its stderr carries diagnostics. User output is always base64 inside output messages, including text that resembles ready or finished. The supervisor retains at most 64 KiB of unsent bytes per stream plus one encoded chunk, below a 256 KiB output-buffer ceiling. Backpressure drops older unsent bytes and sets the affected outputTruncated flag; it preserves the final tail. Callers continue draining, retain their own 64 KiB tails, and combine their truncation flags with the supervisor's flags.

## Cleanup and failure

The first observed command exit, command timeout, cancel or control EOF starts cleanup and fixes its reason. Timeout uses a monotonic clock and never merely closes the output connection. The supervisor signals its actual direct children through pidfds, waits for exits and repeats for newly adopted descendants. TERM grace is shared across all rounds; after it expires, existing and newly adopted children receive KILL. Setsid and double-fork descendants stay within this ownership. Linux `waitpid(-1, WNOHANG | __WALL)` must report ECHILD before cleanup is confirmed; zero still means children remain. See [Linux wait semantics](https://man7.org/linux/man-pages/man2/waitpid.2.html).

Cleanup budget includes signalling, adoption, waiting, draining both user pipes, emitting retained tails and writing finished. Control and pipe operations are nonblocking and bounded per iteration, so busy or unread output does not stop deadline checks, cancellation or reaping. If the peer does not resume reading within the cleanup budget, the supervisor exits nonzero even if the children have already been reaped.

Successful supervision sends one finished and exits zero. Invalid control, duplicate run, incomplete control EOF, capability failure, missing wait status, failed signalling or an exhausted budget exits nonzero without a trustworthy finished. Diagnostics use `error: "supervisor_failed"` and `cleanup: "unconfirmed"`; a broken diagnostic transport does not turn failure into success. The Docker adapter verifies both finished and the supervisor's Docker Exec exit status. An unconfirmed result makes the Runner block and remove that generation; failed removal keeps it blocked until close can confirm deletion. The script cannot certify or perform host-side container removal.

## Docker adapter

[docker.ts](../src/docker.ts) enables stdin and TCP Upgrade without a TTY. After ready, the Runner rechecks the captured execution, full container ID, running state, ownership labels and workspace mount. A failed recheck prevents run. [protocol.ts](../src/protocol.ts) processes Upgrade head bytes and arbitrary Docker/JSON fragments, validates each message and base64 chunk, retains user output separately from supervisor diagnostics, and rejects incomplete or out-of-order streams.

The adapter queues at most one bounded run and one cancel; a backpressured write does not stop incoming protocol processing or cancellation. Cancelling before ready is recorded until the connection becomes ready; cancelling during the recheck prevents its late result from starting the command. Ready and run wait have deadlines, cancellation keeps the result connection open, and cleanup/confirmation bounds remain independent of the command deadline. Repeated cancellation does not extend the budget or replace the first request.

The completion promise remains pending through finished, full stream EOF and Docker Inspect of the same exec/container IDs. A still-running supervisor is inspected again only within the remaining confirmation budget; a stopped supervisor must have exit code zero. The original Bash exit code or signal comes from finished, including nonzero exits. No Start or run is retried. The Runner owns HTTP cancellation and automatic generation recovery; their responses and guarantees are documented in the [package reference](../README.md#use-this-package).

## Linux verification

[tests/supervisor/test_supervisor.py](../tests/supervisor/test_supervisor.py) launches the image's actual supervisor and reads the existing Bash wrapper from `src/server.ts`. Stage that source file and the tests under the same package paths in a dedicated writable `/workspace`; keep the supervisor in the image. Compile [clone_child.c](../tests/supervisor/clone_child.c) using `cc -static -O2 -Wall -Wextra -Werror`, writing `clone-child` beside the test file. The compiler and helper do not belong in the runtime image.

Inside the restricted container, run `python3 -I -B -m unittest discover -s packages/sandbox/sandbox-runner/tests/supervisor -p 'test_*.py' -v` from `/workspace`. Assertions compare finished with independent `/proc` observations and file progress from another execution. The clone fixture creates a real child with exit_signal=0 before adoption. Separate capability-denial container checks verify that initialization fails before user code starts. These checks verify the image supervisor; Runner HTTP cancellation and the built profile require their own integration verification.
