---
kind: upgrade-guide
description: "Runner Exec requires a Python supervisor image and separates command deadlines from cleanup waits."
---

# Runner Exec requires a supervisor image

English | [中文](guide.zh.md)

## Change

Workspace Runner Exec starts a fixed Python supervisor instead of Bash directly. Existing images that provide only Bash and sleep cannot execute commands through the Runner. Command timeout is followed by an independent cleanup/confirmation wait. Confirmed command cleanup keeps its container usable; an unconfirmed result removes the entire generation and interrupts its other commands. Execution errors include cleanup details; sandbox_cleanup_required now uses HTTP 503 instead of 409. Successful response fields and per-generation execution IDs remain unchanged.

## Migration

1. Build [the Runner image](../../../../packages/sandbox/sandbox-runner/image/Dockerfile) using `packages/sandbox/sandbox-runner` as its Docker context. It supplies `/usr/local/bin/python3`, `/bin/bash`, `/usr/bin/sleep` and the root-owned, read-only supervisor. Preload the resulting image on the Runner's Engine.
2. Set `image` in the Runner Cordis configuration, or `DSH_RUNNER_IMAGE` for the [profile template](../../../../team-docs/sandbox-runner-profile/cordis.patch.yml), to the resulting image's repository digest. Retain the existing non-root UID/GID and container restrictions. Close old workspace containers before reopening them with the new image.
3. Review `cleanupTimeoutMs` and `termGraceMs` in the [package reference](../../../../packages/sandbox/sandbox-runner/README.md#use-this-package). The template also accepts `DSH_RUNNER_CLEANUP_TIMEOUT_MS` and `DSH_RUNNER_TERM_GRACE_MS`; TERM grace must be smaller than cleanup budget. Allow the command deadline plus cleanup time in the calling client's request timeout.
4. Through the Runner Exec API, verify normal and nonzero Bash exits, both output streams and a working-directory request. Handle execution_timeout only as confirmed cleanup or no Start; unknown cleanup uses execution_outcome_unknown. Read the identity, reason, cleanup and optional Bash status on execution errors. Reopen after confirmed removal; use DELETE to retry cleanup_required. Update clients that previously treated that error as HTTP 409 or required an exact error-only object. Other preparation/lifecycle failures still return error alone.
5. Cancel with `POST /v1/workspaces/:workspaceId/sandbox/exec/cancel`, supplying only executionId and expectedContainerId. Verify 202/requested while pending and 200/settled after completion. Read the original exec result or retry it unchanged to determine the actual reason and cleanup; cancellation acceptance is not completion. The [Runner reference](../../../../packages/sandbox/sandbox-runner/README.md#use-this-package) defines responses.
