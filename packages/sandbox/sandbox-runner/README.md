---
description: "Configure Docker Engine access and workspace bind mounts for an independent sandbox runner."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-runner

English | [中文](README.zh.md)

## Summary

Open, query, and close workspace sandboxes with a limit of two containers. Each container runs under fixed resource limits and binds one existing workspace directory so its files survive container replacement. The deployment controls the image, identity, and workspace root.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a dedicated Linux Cordis composition with access to the Docker Engine Unix socket. Preload an approved [supervisor image](docs/README.md) by digest with Python, `/usr/bin/sleep`, `/bin/bash`, the immutable supervisor program, and no image-declared volumes. Run one Runner per deployment ID. Keep the canonical workspace root and its ancestors under deployment control so workspace processes cannot replace directory entries, and give each pre-created child permissions for the configured UID and GID.

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-runner) lists the required fields. `requestTimeoutMs` defaults to 10,000 and bounds Docker JSON requests and supervisor readiness. `cleanupTimeoutMs` defaults to 2,000; `termGraceMs` defaults to 250 and must be smaller than cleanupTimeoutMs. These deployment budgets are independent of the command's timeoutMs.

`ctx.sandboxRunner` becomes ready only after startup has removed containers whose project, deployment, and workspace labels identify them as owned. Call `open(workspaceId, directory)` to open or reuse a running container, `status(workspaceId)` to query it, and `close(workspaceId)` to remove it without deleting its directory. A third workspace receives `sandbox_capacity` while the other two slots are occupied. Unloading the Runner cancels in-flight Docker requests during startup cleanup, releases the API socket, and waits for open, close, and status operations already in flight.

Trusted in-process callers pass a previously observed container ID, an execution ID, canonical command arguments, and a command budget to `execute(workspaceId, request)`. Distinct execution IDs can start immediately in the same workspace and share the container's resource limits. Checking whether an open container can be reused allows executions to continue. An `open` call can replace its existing generation only after that generation's executions settle. Matching retries share the pending or stored result, including failures. A generation retains up to 128 distinct execution IDs across pending and completed calls until Docker confirms its removal.

Each execution stays pending through process cleanup and supervisor confirmation. A confirmed timeout or cancellation preserves the container and other commands. `cancel(workspaceId, {executionId, expectedContainerId})` requests cancellation of an existing ID and returns `cancellation: "requested"` or `"settled"`; acceptance does not establish its final reason or cleanup. Unknown IDs fail with execution_not_found, and stale container IDs fail with execution_generation_mismatch. Repeated cancellation does not change a settled result or replace the first accepted reason.

An unknown result after Start synchronously puts the generation in `cleanup_required`, blocks new Start/run, and removes the exact container. Executions interrupted by that removal report execution_container_recycled; the initiating failure reports execution_outcome_unknown. Their promises await removal confirmation or its failure. A failed removal retains the slot and blocks reopening; `close` retries removal. Confirmed removal releases the slot, preserves workspace files and invalidates old-generation retries. Closing shares an active recovery instead of removing twice. Unloading stops admission, requests shutdown cancellation concurrently, and waits for cleanup and any resulting recovery before releasing service resources.

Timeouts, cancellations and unknown or recycled execution outcomes use `SandboxExecutionError.execution`: executionId, containerId, observed reason (null when unknown), cleanup, and Bash status when known. Other preparation failures retain their Docker or lifecycle error. Timeout/cancellation report `not_started` or `processes_cleaned`; unknown/recycled outcomes report `container_removed` or `unconfirmed`. A command that traps TERM and exits zero can still be cancelled. Only a fully confirmed Bash exit returns the success DTO.

The standalone `sandbox-runner` profile exposes the lifecycle over a Linux Unix socket. Use `PUT`, `GET`, and `DELETE` on `/v1/workspaces/:workspaceId/sandbox`. PUT takes JSON with `workspaceDir`. Success returns the state and includes `containerId` for `running`. Failures return an `error` code, including `sandbox_capacity` with HTTP 409 and `docker_unavailable` with HTTP 503.

Use `POST /v1/workspaces/:workspaceId/sandbox/exec` with `executionId`, the full `expectedContainerId` from PUT or GET, and a non-blank Bash `command`. The execution ID has 1–128 UTF-16 code units. The JSON body has a 64 KiB limit. An optional `workdir` is a relative POSIX path without `..` segments and defaults to the workspace root. `timeoutMs` accepts integers from 1 to 60,000 and defaults to 30,000. A confirmed exit returns HTTP 200 with `executionId`, `exitCode`, `stdout`, and `stderr`, even when the exit code is nonzero. Invalid requests return 400 and state or ID conflicts return 409. An unresolved container cleanup returns 503 with sandbox_cleanup_required.

Cancel with `POST /v1/workspaces/:workspaceId/sandbox/exec/cancel`. The JSON body accepts only executionId and expectedContainerId, uses the same identity validation, and is limited to 8 KiB. HTTP 202 returns `{executionId, containerId, cancellation: "requested"}`; HTTP 200 returns the same identity with cancellation=settled. Neither response asserts that cancellation won or cleanup succeeded: await the original exec request or retry it unchanged for the final result. Repeated pending requests share cleanup; settled results remain unchanged. An unknown ID returns 404/execution_not_found, and an old or mismatched generation returns 409/execution_generation_mismatch. Caller disconnects do not request cancellation.

Execution failures retain the top-level error and include executionId, containerId, reason and cleanup, plus bash when its admission/status is known. Unknown reason is null and unknown Bash status is omitted. Other preparation/lifecycle failures keep their existing error-only response. Failure responses do not fabricate exitCode or empty output streams.

| HTTP | error | Cleanup guarantee |
| --- | --- | --- |
| 504 | execution_timeout | not_started or processes_cleaned; reason=timeout. |
| 409 | execution_cancelled | not_started or processes_cleaned; reason records cancelled or shutdown independently of Bash status. |
| 503 | execution_outcome_unknown | container_removed or unconfirmed; a timeout/cancel that loses cleanup confirmation uses this error. |
| 503 | execution_container_recycled | container_removed or unconfirmed; another operation interrupted this execution by retiring its generation. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`ctx.sandboxRunner` uses [Docker Engine API v1.51](https://docs.docker.com/reference/api/engine/version/v1.51/). Creation binds a single existing direct child to `/workspace` and starts no process. Docker subsequently starts the container with a read-only root, no network, all Linux capabilities dropped, a private 32 MiB `/tmp`, one CPU, 512 MiB memory without swap, and 64 PIDs.

Mutating operations on existing containers use full IDs. Close retains the slot until Docker confirms that ID is absent. A timed-out create retains the slot even when the stable name is absent; a later query or close can identify the pending generation by the creation label. If its outcome remains unknown, restart the Runner to run startup cleanup. Startup lists stopped and never-started containers as well as running ones and leaves other deployments untouched.

The fixed Bash wrapper resolves the requested directory from `/workspace` and checks the physical path before starting the user command. If the directory is inaccessible or resolves outside the mount, the wrapper writes an error to stderr and exits with code 125. Docker Exec starts the [supervisor](docs/README.md) with a bidirectional, non-TTY connection. After ready, the Runner rechecks the original execution and container before sending one run with the remaining command budget. User stdout and stderr are decoded from protocol messages and each retain their last 64 KiB in independent storage. Completion requires finished, complete stream EOF, and Inspect confirming the same supervisor exec/container IDs, stopped state, and supervisor exit zero. The original Bash exit code or signal remains separate from the supervisor status.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace sandbox design](../../../team-docs/SANDBOX-DESIGN.md) — the independent deployment and workspaces.
- [Runner deployment](../../../team-docs/SANDBOX-RUNNER.md) — profile template, service accounts, and local requests.
- [Application profiles](../../boot/app-boot/README.md#profiles) — compose a standalone service with the normal launcher.

<a id="model-experience"></a>
## Model Experience

None, as the Runner does not contribute model context or tool output.

#### KV Cache effect

None; Docker requests run outside model request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Workspace authorization** — the caller verifies workspace membership before submitting a request. The Runner uses socket permissions and validates the bind source.
- **Shared filesystem** — the Runner and Docker daemon must see the same workspace paths. A remote TCP daemon is outside this package's supported deployment.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
