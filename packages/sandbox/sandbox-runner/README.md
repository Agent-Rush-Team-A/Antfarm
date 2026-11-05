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

Mount the plugin in a dedicated Linux Cordis composition with access to the Docker Engine Unix socket. Preload an approved image by digest with `/usr/bin/sleep`, `/bin/bash`, and no image-declared volumes. Run one Runner per deployment ID. Keep the canonical workspace root and its ancestors under deployment control so workspace processes cannot replace directory entries, and give each pre-created child permissions for the configured UID and GID.

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-runner) lists the required fields. `requestTimeoutMs` defaults to 10,000 and bounds each Docker JSON request.

`ctx.sandboxRunner` becomes ready only after startup has removed containers whose project, deployment, and workspace labels identify them as owned. Call `open(workspaceId, directory)` to open or reuse a running container, `status(workspaceId)` to query it, and `close(workspaceId)` to remove it without deleting its directory. A third workspace receives `sandbox_capacity` while the other two slots are occupied. Unloading the Runner cancels in-flight Docker requests during startup cleanup, releases the API socket, and waits for open, close, and status operations already in flight.

Trusted in-process callers pass a previously observed container ID, an execution ID, canonical command arguments, and a wait budget to `execute(workspaceId, request)`. Distinct execution IDs can start immediately in the same workspace and share the container's resource limits. Checking whether an open container can be reused allows executions to continue. An `open` call can replace its existing generation only after that generation's executions settle. Matching retries share the pending or stored result, including failures. A generation retains up to 128 distinct execution IDs across pending and completed calls until Docker confirms its removal.

An unconfirmed Start puts the generation in `cleanup_required` and blocks new commands. Commands that have already started can still return their own results while the container is present. Closing removes the container by its full ID. Unloading closes active execution connections and waits for those operations to settle.

The standalone `sandbox-runner` profile exposes the lifecycle over a Linux Unix socket. Use `PUT`, `GET`, and `DELETE` on `/v1/workspaces/:workspaceId/sandbox`. PUT takes JSON with `workspaceDir`. Success returns the state and includes `containerId` for `running`. Failures return an `error` code, including `sandbox_capacity` with HTTP 409 and `docker_unavailable` with HTTP 503.

Use `POST /v1/workspaces/:workspaceId/sandbox/exec` with `executionId`, the full `expectedContainerId` from PUT or GET, and a non-blank Bash `command`. The execution ID has 1–128 UTF-16 code units. The JSON body has a 64 KiB limit. An optional `workdir` is a relative POSIX path without `..` segments and defaults to the workspace root. `timeoutMs` accepts integers from 1 to 60,000 and defaults to 30,000. A confirmed exit returns HTTP 200 with `executionId`, `exitCode`, `stdout`, and `stderr`, even when the exit code is nonzero. Invalid requests return 400, state or ID conflicts return 409, unconfirmed execution returns 503, and an elapsed execution deadline returns 504.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`ctx.sandboxRunner` uses [Docker Engine API v1.51](https://docs.docker.com/reference/api/engine/version/v1.51/). Creation binds a single existing direct child to `/workspace` and starts no process. Docker subsequently starts the container with a read-only root, no network, all Linux capabilities dropped, a private 32 MiB `/tmp`, one CPU, 512 MiB memory without swap, and 64 PIDs.

Mutating operations on existing containers use full IDs. Close retains the slot until Docker confirms that ID is absent. A timed-out create retains the slot even when the stable name is absent; a later query or close can identify the pending generation by the creation label. If its outcome remains unknown, restart the Runner to run startup cleanup. Startup lists stopped and never-started containers as well as running ones and leaves other deployments untouched.

The fixed Bash wrapper resolves the requested directory from `/workspace` and checks the physical path before starting the user command. If the directory is inaccessible or resolves outside the mount, the wrapper writes an error to stderr and exits with code 125. The Docker Exec adapter streams stdout and stderr separately and keeps the last 64 KiB per stream. Retained payloads own their bytes independently of the Engine read buffers. Start uses the execution deadline. After the stream ends, Inspect must confirm the exec ID, container ID, stopped state, and integer exit code. Cancelling the read closes the connection while the command may still be running.

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
