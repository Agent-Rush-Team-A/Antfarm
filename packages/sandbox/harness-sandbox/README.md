---
description: "Authorize native workspace sandbox operations and call an independent local Runner."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

English | [中文](README.zh.md)

## Summary

Open, query, and close workspace sandboxes after checking the authenticated native user's ownership and persistent directory record. The independent Runner owns container state and capacity. HTTP requests have bounded waits and validated results; unconfirmed modifications are never replayed or compensated automatically.

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

Add the optional [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) to Antfarm's default `start:web` or `dev:web` command using the [deployment guide](../../../docs/user/guide/workspace-sandboxes.md). The default entry supplies multiuser login and file services; this overlay adds sandbox management. The multiuser restrictions on host tools remain in effect. The Web process must not have Docker access; run the Runner separately.

```yaml
- id: workspace-sandbox
  name: '@deepseek-ai/dsh-harness-sandbox'
  config:
    socketPath: /run/agentrush-sandbox/runner.sock
    workspaceRoot: /srv/agentrush/workspaces
```

The composition must also load native multiuser, Workspace Registry, Typert and Remote Access services. `workspaceRoot` must match the canonical root used by multiuser allocation and the Runner. New multiuser directories use mode 0700; configure the container's non-root UID to match the Harness allocator, and grant the Runner traversal and mount access during deployment. Opening a sandbox never changes directory permissions or migrates files.

| Setting | Value |
| --- | --- |
| `socketPath` | Required absolute local Runner socket; never supplied by a browser. |
| `workspaceRoot` | Required absolute persistent root; no default. |
| `queryTimeoutMs` | Total GET deadline, default 15,000 ms. |
| `mutationTimeoutMs` | Total PUT/DELETE deadline, default 120,000 ms. |
| `maxResponseBytes` | Maximum complete response body, default 8192 bytes. |

The three Typert methods are `workspaceSandbox/open`, `workspaceSandbox/status`, and `workspaceSandbox/close`, carried by Connection POST `/api/<method>`. Their sole business argument is `request: { workspaceId }`. Use the existing login cookie and Connection Host/Origin checks. Extra fields, owner principals and calls without a user invocation are rejected. Results contain only `{ workspaceId, state }`; container identities and deployment paths never appear in management results.

Each call checks native ownership and the same Workspace Registry id. Opening also validates the saved path as an existing non-symlink direct child of the trusted root, then rechecks ownership before contacting the Runner. Queries and closure remain available when the registered directory is missing or moved. There is no second identity mapping, user database, container cache, operation queue or host execution fallback. Unknown workspaces and cross-user access follow the native `remote-access/denied` policy; invalid business input uses `gateway/bad-request`.

`status` observes `closed`, `starting`, `running`, `closing`, or `cleanup_required` without modifying the sandbox. `close` succeeds only after the Runner confirms `closed`, ending all commands in that container generation while retaining workspace registration, files and sessions. A later authorized open may create another generation.

Removing a native workspace registration requires a fresh Runner observation of `closed`. An admitted open or any other state refuses deletion with `workspace/sandbox-active` and `{ workspaceId, state }`; close the sandbox first. A failed query leaves registration and ownership intact. The deletion guard rejects new opens of that workspace until the registry write or rollback settles; other workspaces remain available. The registry owns the guard across manager unload and reload: it resolves the current active service and refuses native workspace deletion with `sandbox/failed` reason `runner_unavailable` while management is offline. Unloading the plugin waits for admitted deletion guards to settle, and reloading replaces the named guard without retaining the old service.

Runner failures use `sandbox/failed` with `{ reason, outcomeUnknown }`. Stable reasons distinguish `sandbox_capacity`, `sandbox_not_ready`, `sandbox_closing`, `sandbox_cleanup_required`, `sandbox_workspace_conflict`, `sandbox_name_conflict`, `sandbox_outcome_unknown`, `invalid_workspace_directory`, `docker_unavailable`, `runner_unavailable` and `runner_outcome_unknown`. An unknown modification outcome requires a fresh status query; a failed query never synthesizes `closed`. Messages omit raw Runner diagnostics, paths and stacks.

<a id="integration-handoff"></a>
### Integration handoff

| Consumer | Available entry | Remaining integration |
| --- | --- | --- |
| #7: automatic open and Bash forwarding | `ctx.workspaceSandbox.openForUser(userId, workspaceId)` returns validated `running` and full `containerId`; `statusForUser` and `closeForUser` also recheck native ownership. | Capture the authenticated initiating user; pass the confirmed generation to execution. Add request cancellation and late-call rejection. |
| #8: idle reclamation | `statusForUser` and `closeForUser` for the persisted owner and workspace. | Add activity accounting and the 30-minute idle decision. |
| #9: Web controls | The three Typert methods, five states and typed `sandbox/failed` reasons. | Add controls and display; unknown outcomes require observation before another modification. |

Internal explicit-user methods accept only identities recovered by trusted backend code. They do not infer an owner from a missing invocation. The child `sandboxRunnerClient` service is transport only and must not be exposed as a user management API. Service disposal aborts local waits and unregisters methods without sending DELETE; neither disconnect nor timeout confirms container removal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [management service](src/index.ts) owns authorization, directory validation and browser-safe projection. Its [transport child](src/transport.ts) owns the [HTTP client](src/runner-client.ts) and ties request cancellation to Cordis disposal. Each request uses its own connection to the fixed socket. The [wire settings](src/config.ts) supply shared deadline defaults; [public types](src/types.ts) declare sanitized results and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Runner reference](../sandbox-runner/README.md) — lifecycle and persistent directories.
- [Multiuser reference](../../api/multiuser/README.md) — account and workspace ownership.
- [Sandbox subsystem](../../../docs/subsystems/sandbox.md) — generated service reference.

<a id="model-experience"></a>
## Model Experience

None, as management contributes no tools, prompts, or model-visible context.

#### KV Cache effect

None; lifecycle operations run outside model request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment** — the Runner requires Linux Unix sockets and a separately provisioned non-root filesystem identity. Windows named pipes support transport tests only.
- **Integration** — automatic opening, Bash forwarding, idle reclamation, and Web controls remain separate tasks. The optional multiuser profile continues to reject model tools until execution isolation is integrated.
- **Evidence** — local HTTP and profile tests use a controllable Runner. They do not establish real Docker or Vultr acceptance; those require independent deployment checks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
