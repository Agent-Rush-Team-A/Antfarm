---
description: "Enable authenticated workspace sandbox management with an independent Linux Runner."
kind: "user-guide"
---

# Workspace sandbox management

English | [中文](workspace-sandboxes.zh.md)

<a id="prepare-the-deployment"></a>
## Prepare the deployment

Use the optional [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) after deploying the independent Runner described in [Runner deployment](../../../team-docs/SANDBOX-RUNNER.md). Keep Docker credentials and its socket out of the Web process. The Web process needs only the Runner management socket and persistent workspace root.

Set `DSH_MULTIUSER_WORKSPACE_ROOT` to the same canonical Linux directory configured in the Runner, and `DSH_SANDBOX_RUNNER_SOCKET` to its management socket. Choose a root outside Docker's data directory; containerized Harness and Runner processes must see the same absolute path the Engine mounts. Native workspace creation allocates directories with mode 0700: the configured container UID must match the non-root Harness user, while the Runner needs traversal and mount access. Prepare these permissions before starting; opening a sandbox never changes ownership or copies existing workspaces.

Provision accounts with the existing [multiuser maintenance command](../../../packages/api/multiuser/README.md#configuration). Use a separate test storage root for acceptance; provisioning never overwrites an existing account.

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/agentrush/workspaces
export DSH_SANDBOX_RUNNER_SOCKET=/run/agentrush-sandbox/runner.sock
pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open
```

Antfarm's default Web entry provides account login and workspace file services; the overlay adds sandbox management and automatic preparation when an authenticated user sends a message to an owned workspace Session. Preparation failure refuses the message. Its standard preset exposes only foreground Runner Bash; host file tools and terminal handoffs remain denied. The Docker-privileged Runner stays outside Web. Missing required configuration fails startup. When using `pnpm dsh web` directly, load `apps/cli/config/antfarm-web.patch.yml` before this overlay.

<a id="call-the-management-methods"></a>
## Call the management methods

Log in through the existing `/auth/login` flow and create a workspace through the native workspace interface. The backend resolves its saved owner and directory; browser input cannot select a host directory or container.

| Typert method | Business argument | Result |
| --- | --- | --- |
| `workspaceSandbox/open` | `request: { workspaceId }` | `{ workspaceId, state: 'running' }` |
| `workspaceSandbox/status` | `request: { workspaceId }` | `{ workspaceId, state }` |
| `workspaceSandbox/close` | `request: { workspaceId }` | `{ workspaceId, state: 'closed' }` |

Connection carries these methods through POST `/api/<method>` using the ordinary Typert request envelope, login cookie and Host/Origin checks. Cross-user and missing workspace access is denied before contacting the Runner. Management results omit internal paths, container identifiers and stacks.

Status is one current observation: `closed`, `starting`, `running`, `closing`, or `cleanup_required`. A failed query is an error, never a guessed `closed`. Capacity, startup, closing, cleanup, configuration conflict and service failures have distinct stable reasons under `sandbox/failed`; see the [package reference](../../../packages/sandbox/harness-sandbox/README.md#use-this-package).

Closing revokes earlier preparations and cancels active and queued input in the workspace before waiting for admitted opens and removing the container. New opens fail while `closing`. A failed close retains this state and can be retried. If PUT or DELETE has `outcomeUnknown: true`, status remains `closing` even after another DELETE; this protocol cannot prove the old mutation has settled. Plugin reload does not clear it. Follow the [package limitations](../../../packages/sandbox/harness-sandbox/README.md#known-limitations-and-deferred-work) for deployment maintenance; a single `closed` observation or Harness restart is insufficient evidence. Files, sessions and workspace registration remain intact.

Close a workspace's sandbox before removing its workspace registration. Deletion queries the Runner and requires `closed`; an opening or active sandbox returns `workspace/sandbox-active`, and an unavailable Runner leaves the workspace intact. If the management service is unloaded or reloading, deletion is also refused and resumes after the service returns. A moved or missing directory still permits status and close operations, so it does not prevent cleanup.

<a id="automatic-idle-reclamation"></a>
## Automatic idle reclamation

The overlay loads one application-level `sandbox-idle` plugin. A running workspace becomes eligible after all preparation, queued input, model work, commands and cleanup have settled and it remains continuously idle for 30 minutes. A new admitted request starts a new interval when its work finishes. Status polling and viewing persistent files do not keep the container alive. Each round finishes before the next 10-second delay begins, so actual closure may happen later than the threshold.

The backend checks current ownership, the original container and activity again before admitting closure. Work admitted first makes the old scan skip; messages arriving after closure has begun receive the existing closing error. A successful reclamation removes only the container. Files, Sessions and workspace registration remain; the next new message reopens the workspace through the ordinary preparation path. The model receives no management tool or countdown.

To change the timings, apply a deployment patch after the sandbox overlay, targeting `id: sandbox-idle` with `config.idleTimeoutMs` and `config.sweepIntervalMs`. Values and limits are documented in the [idle plugin reference](../../../packages/sandbox/harness-sandbox/README.md#idle-reclamation). Disabling that entry stops future scans and drains an already admitted close; it does not close every container. Keep the entry at application scope, outside per-Session presets.

Failed observations are retained for later bounded queries. Restart or management recovery gives a reliably running container a fresh full interval. Failed or uncertain DELETE retains `closing` and is not retried by the idle scanner. Disabled accounts, missing owners and cleanup-required states require authorized maintenance; the scanner does not grant itself cleanup permission.

<a id="continue-the-integrations"></a>
## Continue the integrations

The optional overlay prepares messages, forwards Bash to the Runner and reclaims idle containers. The model sees `/workspace`, command output and exit status, without sandbox-management parameters. Output uses the Runner's bounded tails; host result spilling is disabled because the model cannot access host spill files. Use the [integration handoff](../../../packages/sandbox/harness-sandbox/README.md#integration-handoff) for authorized internal methods, activity queries and browser APIs. Browser controls belong to #9; other tools require separate isolation.
