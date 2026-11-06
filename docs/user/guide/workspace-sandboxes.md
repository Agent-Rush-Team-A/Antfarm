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
pnpm dsh --profile web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open
```

The overlay enables multiuser login and sandbox management. It retains the native restrictions on model tools, file access and terminal handoffs until execution isolation is connected. It does not load the Docker-privileged Runner into Web. Missing required configuration fails startup.

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

When a modification has `outcomeUnknown: true`, query again to learn its eventual result. The Harness never automatically repeats PUT/DELETE or compensates an uncertain open with a close. Closing ends all commands in that container and succeeds only after confirmed removal; workspace files, sessions and registration remain available for reopening.

Close a workspace's sandbox before removing its workspace registration. Deletion queries the Runner and requires `closed`; an opening or active sandbox returns `workspace/sandbox-active`, and an unavailable Runner leaves the workspace intact. If the management service is unloaded or reloading, deletion is also refused and resumes after the service returns. A moved or missing directory still permits status and close operations, so it does not prevent cleanup.

<a id="continue-the-integrations"></a>
## Continue the integrations

Automatic opening and Bash forwarding belong to #7, idle reclamation to #8, and browser controls to #9. The [integration handoff](../../../packages/sandbox/harness-sandbox/README.md#integration-handoff) names the authorized internal methods and browser API. This overlay provides backend management without adding model tools or sandbox-management prompts.
